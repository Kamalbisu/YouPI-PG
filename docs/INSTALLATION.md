# Installation & Host Environment Setup Guide

## 1. Operating Environment
YOUPI PG is distributed as source code and is engineered to run directly as native host processes on standard Linux (Ubuntu, Debian, RHEL, CentOS) and Windows 10/11 environments.

**Zero Docker Requirement:** Docker, Docker Compose, and external container engines are completely optional and not required. Standard `npm install` works out-of-the-box across all workspace packages.

### Prerequisites
- **Node.js:** v24 or higher (matches `engines` in `package.json`)
- **Database:** PostgreSQL v14+ (local, Docker via `docker compose up -d postgres`, or hosted). Schema is applied with `npm run migrate`
- **Java/JDK (Optional, for Android APK build):** OpenJDK 17+
- **Docker & Docker Compose (Optional):** For containerized zero-setup execution

---

## 2. Quickstart (All Platforms)

YOUPI PG needs a PostgreSQL database. Put its URL in `DATABASE_URL`, apply the migrations once with `npm run migrate`, and the first start seeds the default merchant:

```bash
# 1. Clone repository
git clone <your-repository-url> youpi-pg
cd youpi-pg

# 2. Install dependencies (Standard NPM out-of-the-box)
npm install

# 3. Configure environment (set DATABASE_URL)
cp .env.example .env

# 4. Apply database migrations (idempotent)
npm run migrate

# 5. Start all services
npm start
# or for live development:
npm run dev
```

---

## 3. Linux (Ubuntu / Debian) Production Setup

```bash
# 1. Update system packages
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js 24 LTS & Git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git

# 3. Clone and enter repository
git clone <your-repository-url> youpi-pg
cd youpi-pg

# 4. Install dependencies
npm install

# 5. Configure environment
cp .env.example .env
nano .env

# 6. Apply database migrations
npm run migrate

# 7. Start production cluster
npm start
```

---

## 4. Windows 10 / 11 Setup

```powershell
# 1. Verify Node.js (>= v20.0.0)
node -v

# 2. Install dependencies
npm install

# 3. Configure environment
Copy-Item .env.example .env

# 4. Start services (Zero-config auto-initialization)
npm run dev
```

Navigate to `http://localhost:8090` to access the Control Center supervisor and verify all running services.
