# YouPI PG

A small web app with three separate panels: client, admin and Admin 2 (a read-only auditor).

**User panel** - people sign up, log in, see the payment QR codes the admin gave them, pay, and enter the transaction ID (UTR / reference number). Each submission shows Pending, Confirmed or Rejected (with the reason). Admin messages show up on the dashboard with an unread badge.

**Admin panel** - the admin uploads QR images, assigns them to users (or to everyone), checks the submitted transaction IDs and confirms or rejects them, manages users, and sends notifications.

**Online payments** - clients can also pay by card / UPI / net banking through Easebuzz hosted checkout. Payments are verified server-side, admins can refund and reconcile, and everything is written to a trace.

**Admin 2 panel** - a read-only auditor who can follow every payment activity between admin and client: searchable, filterable timelines, CSV export. It can not change anything.

Built with Next.js 16, React 19, Prisma 7 + PostgreSQL, Tailwind 4 and zod. SMS goes through Brevo.

## Run it locally

You need Node.js 20.9 or newer. No Docker or separate Postgres install is needed: `npm run db:local` starts a local database for you.

### Windows (PowerShell)

```powershell
git clone https://github.com/Kamalbisu/YouPI-PG.git
cd YouPI-PG
npm install
copy .env.example .env
# open .env and set APP_SECRET (see below)

# Terminal 1 - leave this running
npm run db:local

# Terminal 2
npm run db:deploy
$env:SEED_ADMIN_EMAIL="admin@example.com"; $env:SEED_ADMIN_PASSWORD="Choose-A-Strong-Pass-1"; npm run admin:create
$env:SEED_AUDITOR_EMAIL="auditor@example.com"; $env:SEED_AUDITOR_PASSWORD="Choose-A-Strong-Pass-2"; npm run auditor:create
npm run dev
```

### Linux / macOS

```bash
git clone https://github.com/Kamalbisu/YouPI-PG.git
cd YouPI-PG
npm install
cp .env.example .env
# edit .env and set APP_SECRET (see below)

# Terminal 1 - leave this running
npm run db:local

# Terminal 2
npm run db:deploy
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='Choose-A-Strong-Pass-1' npm run admin:create
SEED_AUDITOR_EMAIL=auditor@example.com SEED_AUDITOR_PASSWORD='Choose-A-Strong-Pass-2' npm run auditor:create
npm run dev
```

Then open http://localhost:3000.

Generate an `APP_SECRET` with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

The admin password needs at least 10 characters with an upper-case letter, a lower-case letter and a digit.

### Important: open the app at the address in `APP_URL`

State-changing requests (login, sign up, submit, confirm, ...) are checked to come from the app's own address, as protection against cross-site request forgery. `APP_URL` in `.env` must match the address in your browser, for example `http://localhost:3000`. If you open the app as `http://127.0.0.1:3000` instead, or on another port, change `APP_URL` to match, otherwise actions fail with "Cross-site request blocked". In development the server console prints which values did not match. Scripts such as `curl` must send an `Origin` header with the same address.

## Pages

| Address | Who | What |
| --- | --- | --- |
| `/` | everyone | Landing page |
| `/login` | users | Sign up and log in (SMS code, or username + password) |
| `/dashboard` | users | Own QR codes, transaction ID entry, history, notifications |
| `/admin/login` | admin | Admin sign in (email or username + password) |
| `/admin` | admin | Dashboard: counts of users, QRs and pending / confirmed / rejected transactions |
| `/admin/users` | admin | Users, with search. Open one for the full detail, disable or enable |
| `/admin/qr` | admin | Upload, edit, replace image, deactivate or delete, assign to users |
| `/admin/transactions` | admin | Filter by status or user, search by transaction ID, confirm or reject |
| `/admin/notifications` | admin | Send to one user or all users, see what was sent |
| `/dashboard/payments` | users | Pay online, payment history, receipt / status page, refunds on a payment |
| `/admin/payments` | admin | All online payments with filters and search; detail with refund and reconcile actions |
| `/admin/gateway` | admin | Gateway settings check (which values are set; never shows secrets) |
| `/admin/auditors` | admin | Create and disable Admin 2 accounts |
| `/auditor/login` | Admin 2 | Auditor sign in |
| `/auditor` | Admin 2 | Activity trace with filters, search, pagination and CSV export; payment and user timelines |

The three sides use separate logins. A user session is refused by every admin API, an admin session is refused by every user API, and the Admin 2 (auditor) session can only call read-only (GET) endpoints under `/api/auditor`.

## How it works

- **Sign up**: name, username, mobile number and password. A 6-digit code is sent by SMS to the mobile number; the account is created once it is verified.
- **Log in**: either username + password, or the mobile number + SMS code. Logging in with the code for a number that has no account creates one automatically.
- **Codes**: valid for 5 minutes, one use only, 5 wrong tries, a 45 second wait before asking again, and limits per number and per IP address.
- **QR codes**: PNG, JPEG or WebP up to 2 MB. The file type is checked from the file contents, not the name. Images are stored in the database and served only to users who are allowed to see that QR.
- **Transaction IDs**: 8 to 30 letters and digits, stored in capitals. Every ID can be used once across the whole system. Submissions are rate limited. An admin decision (confirm or reject) is final and is written to the audit log.
- **Deleting a QR** that already has submissions only deactivates it, so history is kept.

## Online payments (Easebuzz)

1. Get **test** credentials (key and salt) from the Easebuzz test dashboard and put them in `.env`: `EASEBUZZ_KEY`, `EASEBUZZ_SALT`, `EASEBUZZ_ENV=test`. Without them "Pay online" is hidden / refused and the rest of the app works as before. Use `EASEBUZZ_ENV=prod` only with live credentials.
2. In the Easebuzz dashboard set the **payment callback (success and failure) URL** to `<APP_URL>/api/payments/callback`. It must be reachable from the internet, so for local testing use a tunnel and set `APP_URL` to that address.
3. For refund status updates set the **refund webhook URL** to `<APP_URL>/api/payments/refund-webhook?token=<EASEBUZZ_WEBHOOK_TOKEN>` (or send the token in an `x-webhook-token` header). Set `EASEBUZZ_WEBHOOK_TOKEN` to a long random value.
4. Open `/admin/gateway` to check which values are set.

How it works:

- The client enters an amount and is sent to Easebuzz hosted checkout. The txnid is random and server-made; the amount is stored in paise.
- The callback is public but trusted only after the response hash is verified and the paid amount matches the stored amount. It is idempotent: repeated callbacks do not change a finished payment. A GET to the callback never changes anything.
- **Reconcile** (admin, per payment or for all pending ones) asks Easebuzz for the real status of payments that never got a callback.
- **Refunds** (admin only, on paid payments, full or partial, never above the amount left). The refund row is written to the database first, then the gateway is called. If the gateway outcome is unknown the row stays queued and still counts against the limit; **retry** reuses the same refund id so it can not double-refund.
- Only a sanitised copy of the gateway response is stored on the payment (card numbers, hashes, keys are blanked). Secrets are never logged.
- The old QR + transaction ID flow still works unchanged.

Not verified against the live service: see the pull request. In particular the refund-webhook hash formula is assumed; set `EASEBUZZ_WEBHOOK_HASH=off` to rely on the token alone if Easebuzz signs it differently.

## Admin 2 (auditor)

Admin 2 is a read-only role that traces payment activity between admin and client.

- Create an account with the command line (`SEED_AUDITOR_EMAIL=... SEED_AUDITOR_PASSWORD=... npm run auditor:create`) or as admin under `/admin/auditors`.
- Sign in at `/auditor/login`. The auditor can filter and search the trace (by user, payment, action, date), open a payment or user timeline, and export CSV. All write endpoints answer 403 to an auditor.
- Every important action (payment created / paid / failed, refund requested / completed, reconcile, manual transaction confirmed / rejected, QR assigned, notification sent, auditor created, ...) is written to an **append-only** `ActivityEvent` table. Database triggers reject UPDATE and DELETE on it. TRUNCATE is deliberately not blocked (the tests need it) - restrict that permission on the production database user.
- Secrets, OTPs, tokens and card data are blanked before an event is stored.

## Environment variables

Set these in `.env` (copy from `.env.example`).

| Name | Needed | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. The default matches `npm run db:local` |
| `APP_URL` | yes | Address of the app in the browser, e.g. `http://localhost:3000` |
| `APP_SECRET` | yes in production | Random string, at least 16 characters |
| `TRUST_PROXY` | no | `true` only behind a trusted proxy (so client IPs are read correctly) |
| `BREVO_API_KEY` | production | Brevo API key. Leave empty in development |
| `BREVO_SMS_SENDER` | production | Sender name (up to 11 letters/digits) approved in Brevo |
| `DEFAULT_COUNTRY_CODE` | no | Added to 10-digit numbers. Default `+91` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME`, `SEED_ADMIN_USERNAME` | for `admin:create` | Details of the first admin |
| `SEED_AUDITOR_EMAIL`, `SEED_AUDITOR_PASSWORD`, `SEED_AUDITOR_NAME`, `SEED_AUDITOR_USERNAME` | for `auditor:create` | Details of an Admin 2 account |
| `EASEBUZZ_KEY`, `EASEBUZZ_SALT` | for online payments | Easebuzz merchant key and salt (keep secret) |
| `EASEBUZZ_ENV` | no | `test` (default) or `prod` |
| `EASEBUZZ_WEBHOOK_TOKEN` | for refund webhook | Shared token the webhook must present |
| `EASEBUZZ_WEBHOOK_HASH` | no | `refund` (default, assumed formula) or `off` |

### SMS and OTP codes in development

Without `BREVO_API_KEY` no SMS is sent. In development the code is printed in the terminal that runs `npm run dev`, in a block starting with `[sms:dev]` that contains the message and the 6-digit code. In production, with no key set, asking for a code fails with a clear error instead of silently doing nothing.

To send real SMS, put the key and sender in `.env`:

```
BREVO_API_KEY=your-brevo-api-key
BREVO_SMS_SENDER=YOUPI
```

Notes: Brevo has to approve or register the sender name for your account. SMS to Indian numbers also needs DLT registration (sender and template) with the operator; that is registered by you, outside this app.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server (slower than production) |
| `npm run build` then `npm start` | Production build and server (faster) |
| `npm run db:local` | Local Postgres on port 5433, data kept in `.local/` |
| `npm run db:deploy` | Apply database migrations |
| `npm run admin:create` | Create (or update) the admin account |
| `npm run auditor:create` | Create (or update) an Admin 2 (auditor) account |
| `npm test` | Run the tests (they start their own throwaway database) |
| `npm run typecheck`, `npm run lint` | Checks |

## Upgrading to the payment gateway version

If you already have the two-panel database, `npm run db:deploy` applies the gateway migration on top (new Payment, Refund and ActivityEvent tables, AUDITOR role). Nothing is lost.

## Upgrading from the earlier version

The previous multi-business version of this project had a different database. This version replaces its migrations with a single new one. An existing database cannot be upgraded in place: use a new empty database (for local development, stop `db:local` and delete the `.local` folder), then run `npm run db:deploy` and `npm run admin:create` again.
