/**
 * Sends one test email through Brevo to check the setup.
 * Usage: npm run email:test -- you@example.com
 */
import "dotenv/config";
import { env } from "../src/lib/env";

async function main() {
  const to = process.argv[2]?.trim();
  if (!to) {
    console.error("Usage: npm run email:test -- you@example.com");
    process.exit(1);
  }
  const e = env();
  console.log(`Key set: ${e.BREVO_API_KEY ? "yes (" + e.BREVO_API_KEY.length + " chars, starts " + e.BREVO_API_KEY.slice(0, 7) + ")" : "NO"}`);
  console.log(`Sender: ${e.BREVO_SENDER_EMAIL ?? "NOT SET"} (${e.BREVO_SENDER_NAME})`);
  if (!e.BREVO_API_KEY || !e.BREVO_SENDER_EMAIL) {
    console.error("BREVO_API_KEY and BREVO_SENDER_EMAIL must both be set in .env");
    process.exit(1);
  }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": e.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { name: e.BREVO_SENDER_NAME, email: e.BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      subject: "YouPI PG test email",
      textContent: "If you can read this, Brevo accepted the message from YouPI PG.",
    }),
  });
  console.log(`Brevo answered HTTP ${res.status}: ${await res.text()}`);
  console.log(res.ok ? "Accepted. Now check the inbox/spam and Brevo > Transactional > Logs." : "Rejected: fix the reason above.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
