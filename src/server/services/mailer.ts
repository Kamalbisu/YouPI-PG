import { AppError } from "@/lib/errors";
import { env, isProd } from "@/lib/env";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Send a transactional email through Brevo.
 * Without BREVO_API_KEY / BREVO_SENDER_EMAIL (development / tests) nothing is sent: the
 * message is printed to the server console instead. That fallback is disabled in production.
 */
export async function sendEmail(
  to: string,
  message: { subject: string; text: string },
  opts: { devLabel?: string } = {},
): Promise<void> {
  const e = env();
  if (!e.BREVO_API_KEY || !e.BREVO_SENDER_EMAIL) {
    if (isProd()) {
      console.error("Email not sent: BREVO_API_KEY / BREVO_SENDER_EMAIL are not configured");
      throw new AppError("EMAIL_UNAVAILABLE", "We could not send the email right now. Please try again later.");
    }
    if (e.NODE_ENV !== "test") {
      console.log(`\n[email:dev] ${opts.devLabel ?? "Email"} to ${to} (Brevo not configured, nothing was sent)\n[email:dev] ${message.subject}\n[email:dev] ${message.text}\n`);
    }
    return;
  }
  let res: Response;
  try {
    res = await fetch(BREVO_URL, {
      method: "POST",
      headers: { "api-key": e.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: e.BREVO_SENDER_NAME, email: e.BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${escapeHtml(message.text).replace(/\n/g, "<br>")}</div>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("Brevo email request failed:", err instanceof Error ? err.name : "error");
    throw new AppError("EMAIL_UNAVAILABLE", "We could not send the email right now. Please try again later.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { code?: string; message?: string };
      detail = `${j.code ?? ""} ${j.message ?? ""}`.trim();
    } catch {
      /* ignore */
    }
    console.error(`Brevo email rejected (HTTP ${res.status}) ${detail}`);
    throw new AppError("EMAIL_UNAVAILABLE", "We could not send the email right now. Please try again later.");
  }
  // Brevo accepted the message. This id is what to look for under Transactional > Logs in Brevo.
  let messageId = "";
  try {
    messageId = ((await res.json()) as { messageId?: string }).messageId ?? "";
  } catch {
    /* ignore */
  }
  if (e.NODE_ENV !== "test") console.log(`[email] accepted by Brevo for ${to} from ${e.BREVO_SENDER_EMAIL} ${messageId}`.trim());
}
