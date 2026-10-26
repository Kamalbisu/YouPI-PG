# YouPI PG

A small web app with two separate panels.

**User panel** - people sign up, log in, see the payment QR codes the admin gave them, pay, and enter the transaction ID (UTR / reference number). Each submission shows Pending, Confirmed or Rejected (with the reason). Admin messages show up on the dashboard with an unread badge.

**Admin panel** - the admin uploads QR images, assigns them to users (or to everyone), checks the submitted transaction IDs and confirms or rejects them, manages users, and sends notifications.

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

The user and admin sides use separate logins. A user session is refused by every admin API and an admin session is refused by every user API.

## How it works

- **Sign up**: name, username, mobile number and password. A 6-digit code is sent by SMS to the mobile number; the account is created once it is verified.
- **Log in**: either username + password, or the mobile number + SMS code. Logging in with the code for a number that has no account creates one automatically.
- **Codes**: valid for 5 minutes, one use only, 5 wrong tries, a 45 second wait before asking again, and limits per number and per IP address.
- **QR codes**: PNG, JPEG or WebP up to 2 MB. The file type is checked from the file contents, not the name. Images are stored in the database and served only to users who are allowed to see that QR.
- **Transaction IDs**: 8 to 30 letters and digits, stored in capitals. Every ID can be used once across the whole system. Submissions are rate limited. An admin decision (confirm or reject) is final and is written to the audit log.
- **Deleting a QR** that already has submissions only deactivates it, so history is kept.

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
| `npm test` | Run the tests (they start their own throwaway database) |
| `npm run typecheck`, `npm run lint` | Checks |

## Upgrading from the earlier version

The previous multi-business version of this project had a different database. This version replaces its migrations with a single new one. An existing database cannot be upgraded in place: use a new empty database (for local development, stop `db:local` and delete the `.local` folder), then run `npm run db:deploy` and `npm run admin:create` again.
