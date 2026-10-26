import { AppError } from "@/lib/errors";
import { env, isProd } from "@/lib/env";

const BREVO_URL = "https://api.brevo.com/v3/transactionalSMS/send";

/**
 * Send a transactional SMS through Brevo.
 * Without BREVO_API_KEY (development / tests) nothing is sent: the message is printed to
 * the server console instead. That fallback is disabled in production.
 */
export async function sendSms(phoneE164: string, content: string, opts: { devLabel?: string } = {}): Promise<void> {
  const e = env();
  if (!e.BREVO_API_KEY || !e.BREVO_SMS_SENDER) {
    if (isProd()) {
      console.error("SMS not sent: BREVO_API_KEY / BREVO_SMS_SENDER are not configured");
      throw new AppError("SMS_UNAVAILABLE", "We could not send the SMS right now. Please try again later.");
    }
    if (e.NODE_ENV !== "test") {
      console.log(`\n[sms:dev] ${opts.devLabel ?? "SMS"} to ${phoneE164} (Brevo not configured, nothing was sent)\n[sms:dev] ${content}\n`);
    }
    return;
  }
  let res: Response;
  try {
    res = await fetch(BREVO_URL, {
      method: "POST",
      headers: { "api-key": e.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: e.BREVO_SMS_SENDER,
        recipient: phoneE164.replace(/^\+/, ""),
        content,
        type: "transactional",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("Brevo SMS request failed:", err instanceof Error ? err.name : "error");
    throw new AppError("SMS_UNAVAILABLE", "We could not send the SMS right now. Please try again later.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { code?: string; message?: string };
      detail = `${j.code ?? ""} ${j.message ?? ""}`.trim();
    } catch {
      /* ignore */
    }
    console.error(`Brevo SMS rejected (HTTP ${res.status}) ${detail}`);
    throw new AppError("SMS_UNAVAILABLE", "We could not send the SMS right now. Please try again later.");
  }
}
