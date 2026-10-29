import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { sendEmail } from "@/server/services/mailer";

const KEYS = ["MSG91_AUTH_KEY", "MSG91_SENDER_EMAIL", "MSG91_OTP_TEMPLATE_ID", "MSG91_EMAIL_DOMAIN"] as const;

function configure(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
  resetEnvCache();
}

afterEach(() => {
  configure({});
  vi.unstubAllGlobals();
});

const MSG = { subject: "123456 is your code", text: "Your code is 123456.", variables: { otp: "123456" } };

describe("MSG91 mailer", () => {
  it("sends nothing outside production when MSG91 is not configured", async () => {
    configure({ MSG91_SENDER_EMAIL: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail("asha@example.com", MSG);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the template, sender, domain and otp variable to MSG91", async () => {
    configure({ MSG91_AUTH_KEY: "key123", MSG91_SENDER_EMAIL: "no-reply@youpi.in", MSG91_OTP_TEMPLATE_ID: "login_code" });
    const fetchMock = vi.fn(async () => Response.json({ status: "success", hasError: false, data: { unique_id: "u1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail("asha@example.com", MSG);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://control.msg91.com/api/v5/email/send");
    expect((init.headers as Record<string, string>).authkey).toBe("key123");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      recipients: [{ to: [{ email: "asha@example.com" }], variables: { otp: "123456", company_name: "YouPI PG" } }],
      from: { email: "no-reply@youpi.in", name: "YouPI PG" },
      domain: "youpi.in",
      template_id: "login_code",
    });
  });

  it("throws EMAIL_UNAVAILABLE when MSG91 rejects the request", async () => {
    configure({ MSG91_AUTH_KEY: "bad", MSG91_SENDER_EMAIL: "no-reply@youpi.in", MSG91_OTP_TEMPLATE_ID: "login_code" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "fail", hasError: true, errors: { authkey: ["Invalid"] } }, { status: 401 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendEmail("asha@example.com", MSG)).rejects.toMatchObject({ code: "EMAIL_UNAVAILABLE" });
  });
});
