/**
 * Sends one test login-code email through MSG91 to check the setup.
 * Usage: npm run email:test -- you@example.com
 */
import "dotenv/config";
import { env } from "../src/lib/env";
import { senderDomain } from "../src/server/services/mailer";

async function main() {
  const to = process.argv[2]?.trim();
  if (!to) {
    console.error("Usage: npm run email:test -- you@example.com");
    process.exit(1);
  }
  const e = env();
  console.log(`Auth key set: ${e.MSG91_AUTH_KEY ? "yes (" + e.MSG91_AUTH_KEY.length + " chars)" : "NO"}`);
  console.log(`Sender: ${e.MSG91_SENDER_EMAIL ?? "NOT SET"} (${e.MSG91_SENDER_NAME}), domain: ${senderDomain(e) || "NOT SET"}`);
  console.log(`Template: ${e.MSG91_OTP_TEMPLATE_ID ?? "NOT SET"}`);
  if (!e.MSG91_AUTH_KEY || !e.MSG91_SENDER_EMAIL || !e.MSG91_OTP_TEMPLATE_ID) {
    console.error("MSG91_AUTH_KEY, MSG91_SENDER_EMAIL and MSG91_OTP_TEMPLATE_ID must all be set in .env");
    process.exit(1);
  }
  const res = await fetch("https://control.msg91.com/api/v5/email/send", {
    method: "POST",
    headers: { authkey: e.MSG91_AUTH_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      recipients: [{ to: [{ email: to }], variables: { company_name: e.MSG91_SENDER_NAME, otp: "123456" } }],
      from: { name: e.MSG91_SENDER_NAME, email: e.MSG91_SENDER_EMAIL },
      domain: senderDomain(e),
      template_id: e.MSG91_OTP_TEMPLATE_ID,
    }),
  });
  const text = await res.text();
  console.log(`MSG91 answered HTTP ${res.status}: ${text}`);
  const ok = res.ok && /"status"\s*:\s*"success"/.test(text);
  console.log(ok ? "Queued (test code 123456). Now check the inbox/spam and MSG91 > Email > Logs." : "Rejected: fix the reason above.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
