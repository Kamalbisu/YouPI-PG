import { AppError } from "@/lib/errors";
import { env, isProd } from "@/lib/env";

const MSG91_URL = "https://control.msg91.com/api/v5/email/send";

const unavailable = () => new AppError("EMAIL_UNAVAILABLE", "We could not send the email right now. Please try again later.");

/** Sender domain: MSG91_EMAIL_DOMAIN, or the part after "@" in the sender address. */
export function senderDomain(e: { MSG91_EMAIL_DOMAIN?: string; MSG91_SENDER_EMAIL?: string }): string {
  return e.MSG91_EMAIL_DOMAIN || (e.MSG91_SENDER_EMAIL?.split("@")[1] ?? "");
}

/**
 * Send a transactional email through MSG91, using the email template MSG91_OTP_TEMPLATE_ID.
 * MSG91 builds the message from that template; `variables` fill its placeholders (e.g. otp).
 * `subject` and `text` are only used for the development console fallback.
 * Without MSG91_AUTH_KEY / MSG91_SENDER_EMAIL / MSG91_OTP_TEMPLATE_ID (development / tests) nothing
 * is sent: the message is printed to the server console instead. That fallback is disabled in production.
 */
export async function sendEmail(
  to: string,
  message: { subject: string; text: string; variables?: Record<string, string> },
  opts: { devLabel?: string } = {},
): Promise<void> {
  const e = env();
  if (!e.MSG91_AUTH_KEY || !e.MSG91_SENDER_EMAIL || !e.MSG91_OTP_TEMPLATE_ID) {
    if (isProd()) {
      console.error("Email not sent: MSG91_AUTH_KEY / MSG91_SENDER_EMAIL / MSG91_OTP_TEMPLATE_ID are not configured");
      throw unavailable();
    }
    if (e.NODE_ENV !== "test") {
      console.log(`\n[email:dev] ${opts.devLabel ?? "Email"} to ${to} (MSG91 not configured, nothing was sent)\n[email:dev] ${message.subject}\n[email:dev] ${message.text}\n`);
    }
    return;
  }
  let res: Response;
  try {
    res = await fetch(MSG91_URL, {
      method: "POST",
      headers: { authkey: e.MSG91_AUTH_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        recipients: [{ to: [{ email: to }], variables: { company_name: e.MSG91_SENDER_NAME, ...message.variables } }],
        from: { name: e.MSG91_SENDER_NAME, email: e.MSG91_SENDER_EMAIL },
        domain: senderDomain(e),
        template_id: e.MSG91_OTP_TEMPLATE_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("MSG91 email request failed:", err instanceof Error ? err.name : "error");
    throw unavailable();
  }
  let body: { status?: string; hasError?: boolean; message?: string; errors?: unknown; data?: { unique_id?: string } } = {};
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || body.hasError || (body.status && body.status !== "success")) {
    console.error(`MSG91 email rejected (HTTP ${res.status}) ${body.message ?? ""} ${body.errors ? JSON.stringify(body.errors) : ""}`.trim());
    throw unavailable();
  }
  // MSG91 queued the message. Look this id up under Email > Logs in the MSG91 panel.
  if (e.NODE_ENV !== "test") console.log(`[email] queued by MSG91 for ${to} from ${e.MSG91_SENDER_EMAIL} ${body.data?.unique_id ?? ""}`.trim());
}
