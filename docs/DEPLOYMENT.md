# YOUPI PG V2 — Deployment & Installation Guide

This document describes how to deploy and run the clean distributable **YOUPI PG V2** package.

---

## 1. Prerequisites

- **Operating System**: Linux (Ubuntu 22.04+ / Debian 12+), macOS, or Windows 10/11 / Windows Server.
- **Node.js**: Version `>= 20.0.0` (LTS recommended).
- **Package Manager**: `npm` (included with Node.js).
- **Network Ports**:
  - `6100`: Payment Core API
  - `7000`: Checkout Portal & `youpi.js` SDK host
  - `6001`: Merchant Admin Panel
  - `5000`: Demo Coin Wallet Store (Reference Implementation)
  - `6002`: SMS Observer
  - `6003`: Gmail Observer
  - `8090`: Control Center Supervisor

---

## 2. Installation Steps

### Step 1: Extract / Clone Package
Ensure you are in the package root directory:
```bash
cd "YOUPI PG PACKAGE"
```

### Step 2: Configure Environment
Copy the clean template to `.env`:
```bash
cp .env.example .env
```
Open `.env` in your editor and configure:
1. `ENCRYPTION_MASTER_KEY` (optional): a 64-character hex key (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). If unset, one is generated into `data/.secrets/`. Placeholder values are ignored.
2. Admin access uses the `ADMIN_API_TOKEN` bearer token (auto-generated into `data/.secrets/admin_api_token` when unset). `JWT_SECRET` and `INITIAL_ADMIN_*` are no longer used.
3. `BASE_PAYMENT_API_URL` and `BASE_CHECKOUT_URL`: Your public domain or localhost URLs.

### Step 3: Install Dependencies
```bash
npm install
```

### Step 4: Apply Database Migrations
Set `DATABASE_URL` in `.env` (and `PGSSLMODE=require` for most hosted databases), then apply the schema:
```bash
npm run migrate
```
*(Creates `schema_migrations` and applies the files in `/migrations` in order. Safe to run again; already-applied files are skipped. The default merchant and receiving account are seeded on the first service start.)*

Against a hosted database without a local `.env`:
```bash
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DBNAME" PGSSLMODE=require npm run migrate
```
With Docker Compose, `YOUPI_AUTO_MIGRATE=true` (the compose default) applies migrations when the gateway starts, or run `docker compose run --rm gateway node migrate.js`.

#### Copying data from an old SQLite install (optional)
Existing SQLite data is not migrated automatically. After `npm run migrate`, a one-off copy is available:

```bash
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DBNAME" PGSSLMODE=require node scripts/sqlite-to-postgres.js ./data/youpi_pg.sqlite --dry-run
DATABASE_URL="..." PGSSLMODE=require node scripts/sqlite-to-postgres.js ./data/youpi_pg.sqlite
```

It reads the file read-only, copies all 13 tables in one transaction, and skips rows that already exist (re-runnable). `--dry-run` rolls back.

### Step 5: Start the System

#### Development / Demonstration Mode:
```bash
npm run dev
```
Starts all services with live reload and console aggregation under the Control Center at `http://localhost:8090`.

#### Production Mode:
```bash
npm run start
```
Starts services in background daemon mode.

---

## 3. Verifying Your Installation

1. **Checkout Portal & SDK**:
   Open `http://localhost:7000/youpi.js` — you should see the official JavaScript SDK.
2. **Demo Store**:
   Open `http://localhost:5000` — you should see the reference YOUPI Store with the interactive buy button and Developer Guide.
3. **Merchant Admin**:
   Open `http://localhost:6001` and log in with your admin credentials from `.env`.
   Configure your active UPI ID and payee name in the Receiving Accounts tab.
4. **Health Check**:
   `curl http://localhost:6100/health` returns `{"status":"UP"}`.

---

## 4. Production Domain & SSL (Cloudflare / NGINX)

For production deployment:
1. Terminate SSL at your reverse proxy (NGINX, Caddy, or Cloudflare Tunnel).
2. Point your public domain (e.g. `pay.yourdomain.com`) to port `7000` (Checkout Portal) or `6100` (Payment API).
   *The Checkout Portal automatically proxies all `/api/*` requests to the Payment API.*
3. Update `BASE_PAYMENT_API_URL` and `BASE_CHECKOUT_URL` in `.env` to match your public HTTPS domain.
