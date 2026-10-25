import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentStatus } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

if (!process.env.BASE_CHECKOUT_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(rootDir, '.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}
import {
  getDatabase,
  initDatabase,
  MerchantRepository,
  ReceivingAccountRepository,
  CustomerRepository,
  CustomerSessionRepository,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  DeviceRepository
} from '@youpi/db';
import {
  QueueEngine,
  TimingEngine,
  AttributionEngine,
  RecoveryEngine,
  WebhookEngine,
  PaymentVerificationPipeline
} from '@youpi/core';
import { HttpServer } from './server.js';
import { authGuard } from './auth-guard.js';
import { registerPaymentRoutes } from './routes/payments.routes.js';
import { registerCheckoutRoutes } from './routes/checkout.routes.js';
import { registerPollerRoutes } from './routes/pollers.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerCustomerRoutes } from './routes/customer.routes.js';
import { registerDeviceRoutes } from './routes/device.routes.js';
import { getWhatsAppBerryService, WhatsAppBerryService } from './services/whatsapp-berry.service.js';
import { ObserverPollerService } from './services/observer-poller.service.js';

export async function createPaymentApp(customDb = null, options = {}) {
  const db = customDb || getDatabase();
  const { defaultMerchant } = await initDatabase(db);
  const isCustom = !!customDb;
  const whatsappBerryService = options.whatsappBerryService || (isCustom ? new WhatsAppBerryService({
    sessionId: 'test_berry_session',
    sessionPath: path.resolve(rootDir, 'data/test_berry_auth'),
    databasePath: path.resolve(rootDir, 'data/test_berry_store.db'),
    metaFile: path.resolve(rootDir, 'data/test_whatsapp_session.json')
  }) : getWhatsAppBerryService());

  const merchantRepo = new MerchantRepository(db);
  const accountRepo = new ReceivingAccountRepository(db);
  const customerRepo = new CustomerRepository(db);
  const customerSessionRepo = new CustomerSessionRepository(db, customerRepo);
  const sessionRepo = new PaymentSessionRepository(db);
  const obsRepo = new ObservationRepository(db);
  const ticketRepo = new SupportTicketRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const deviceRepo = new DeviceRepository(db);

  const eventEmitter = new EventEmitter();

  const parseWindowMs = (raw, fallback, label) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 24 * 60 * 60 * 1000) {
      console.warn(`[config] Ignoring invalid ${label}=${raw}; using ${fallback}ms.`);
      return fallback;
    }
    return Math.floor(value);
  };
  const activeDurationMs = parseWindowMs(process.env.PAYMENT_ACTIVE_WINDOW_MS, 300000, 'PAYMENT_ACTIVE_WINDOW_MS');
  const processingDurationMs = parseWindowMs(process.env.PAYMENT_PROCESSING_WINDOW_MS, 30000, 'PAYMENT_PROCESSING_WINDOW_MS');

  const queueEngine = new QueueEngine({
    sessionRepo,
    accountRepo,
    eventEmitter,
    auditRepo,
    activeDurationMs,
    processingDurationMs
  });

  const timingEngine = new TimingEngine({
    sessionRepo,
    queueEngine,
    eventEmitter,
    auditRepo,
    activeDurationMs,
    processingDurationMs
  });

  const attributionEngine = new AttributionEngine({
    sessionRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    eventEmitter
  });

  const recoveryEngine = new RecoveryEngine({
    db,
    sessionRepo,
    accountRepo,
    queueEngine,
    timingEngine,
    auditRepo,
    eventEmitter
  });

  const webhookEngine = new WebhookEngine({
    db,
    merchantRepo,
    maxRetries: Number(process.env.WEBHOOK_MAX_RETRIES || 5)
  });

  const server = new HttpServer();
  server.use(authGuard);
  let checkoutBaseUrl = process.env.BASE_CHECKOUT_URL || 'http://localhost:7000';
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      const raw = fs.readFileSync(rootEnv, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('BASE_CHECKOUT_URL=')) {
          const val = trimmed.split('=')[1]?.trim();
          if (val) checkoutBaseUrl = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {}

  const pendingHandlers = new Set();
  eventEmitter.settle = async () => {
    while (pendingHandlers.size) await Promise.allSettled([...pendingHandlers]);
  };
  const onAsync = (event, handler) => {
    eventEmitter.on(event, (data) => {
      const p = Promise.resolve().then(() => handler(data)).catch((err) => {
        console.error(`[events] ${event} handler failed:`, err?.message || err);
      }).finally(() => pendingHandlers.delete(p));
      pendingHandlers.add(p);
    });
  };

  async function handleSlotFreedAndPromote(receivingAccountId) {
    if (!receivingAccountId) return null;
    const promoted = await queueEngine.promoteNext(receivingAccountId);
    if (promoted) {
      if (promoted.expiresAt) {
        await timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
      }
      server.broadcastSse(promoted.id, 'status_change', {
        status: PaymentStatus.ACTIVE,
        queuePosition: 0,
        expiresAt: promoted.expiresAt
      });
      server.broadcastSse(`queue_${receivingAccountId}`, 'queue_update', {
        promotedId: promoted.id
      });
    }
    return promoted;
  }

  onAsync('PAYMENT.SUCCESS', async (data) => {
    const session = await sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.SUCCESS,
        verificationLevel: data.verificationLevel || session.verificationLevel || 1,
        verificationTag: data.verificationTag || session.verificationTag,
        sources: data.sources || session.verificationSources
      });
      webhookEngine.dispatch('SUCCESS', session).catch(() => {});
      await handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.LEVEL1_VERIFIED', (data) => {
    server.broadcastSse(data.paymentId, 'status_change', {
      status: 'VERIFYING',
      verificationLevel: 1,
      verificationTag: data.verificationTag,
      message: 'Payment detected! Verifying secondary channel...'
    });
  });

  onAsync('PAYMENT.FAILED', async (data) => {
    const session = await sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('FAILED', session).catch(() => {});
      await handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  onAsync('PAYMENT.EXPIRED', async (data) => {
    const session = await sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.EXPIRED
      });
      webhookEngine.dispatch('EXPIRED', session).catch(() => {});
      await handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  onAsync('PAYMENT.CANCELLED', async (data) => {
    const session = await sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.CANCELLED
      });
      webhookEngine.dispatch('CANCELLED', session).catch(() => {});
      await handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.FRAUD_BLOCKED', (data) => {
    if (data.sessionId) {
      server.broadcastSse(data.sessionId, 'status_change', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION',
        blockedNotice: {
          title: 'FRAUDULENT ACTIVITY DETECTED',
          subtitle: 'Payment Session Terminated & Account Suspended',
          message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
          investigating: true
        }
      });
      server.broadcastSse(data.sessionId, 'account_blocked', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION'
      });
    }
  });


  const queueSyncDaemon = setInterval(async () => {
    try {
      const nowIso = new Date().toISOString();

      const expiredActive = await db.query(`
        SELECT id, merchant_id, order_id, receiving_account_id FROM payment_sessions
        WHERE status = 'ACTIVE' AND expires_at <= ?
      `, [nowIso]);

      for (const row of expiredActive) {
        await sessionRepo.transitionToTerminal(row.id, PaymentStatus.EXPIRED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.EXPIRED });
        eventEmitter.emit('PAYMENT.EXPIRED', {
          paymentId: row.id,
          orderId: row.order_id,
          merchantId: row.merchant_id
        });
        await handleSlotFreedAndPromote(row.receiving_account_id);
      }

      const failedProc = await db.query(`
        SELECT id, merchant_id, order_id, receiving_account_id FROM payment_sessions
        WHERE status = 'PROCESSING' AND processing_expires_at <= ?
      `, [nowIso]);

      for (const row of failedProc) {
        await sessionRepo.transitionToTerminal(row.id, PaymentStatus.FAILED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.FAILED });
        eventEmitter.emit('PAYMENT.FAILED', {
          paymentId: row.id,
          orderId: row.order_id,
          merchantId: row.merchant_id
        });
        await handleSlotFreedAndPromote(row.receiving_account_id);
      }

      const vacantAccounts = await db.query(`
        SELECT id FROM payment_receiving_accounts
        WHERE is_active = true AND (is_slot_busy = false OR current_active_session_id IS NULL)
      `);

      for (const acc of vacantAccounts) {
        await handleSlotFreedAndPromote(acc.id);
      }
    } catch {}
  }, 1000);

  if (queueSyncDaemon.unref) queueSyncDaemon.unref();

  const webhookRetryDaemon = setInterval(async () => {
    try {
      const outcome = await webhookEngine.retryPending();
      if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {});
    } catch {}
  }, Number(process.env.WEBHOOK_RETRY_INTERVAL_MS || 5000));

  if (webhookRetryDaemon.unref) webhookRetryDaemon.unref();

  const observerPollerService = new ObserverPollerService({
    db,
    sessionRepo,
    obsRepo,
    attributionEngine,
    eventEmitter,
    pollIntervalMs: Number(process.env.OBSERVER_POLL_INTERVAL_MS || 1500),
    minSweepCooldownMs: Number(process.env.OBSERVER_SWEEP_COOLDOWN_MS || 2000),
    smsPort: Number(process.env.SMS_OBSERVER_PORT || 6002),
    gmailPort: Number(process.env.GMAIL_OBSERVER_PORT || 6003)
  });

  const recoveryStats = await recoveryEngine.recover();

  const healthHandler = (req, res) => {
    HttpServer.json(res, 200, {
      status: 'UP',
      service: 'payment-api',
      timestamp: new Date().toISOString(),
      recoveryStats
    });
  };
  server.get('/health', healthHandler);
  server.get('/api/v1/health', healthHandler);

  const pipeline = new PaymentVerificationPipeline({
    db,
    sessionRepo,
    obsRepo,
    customerRepo,
    attributionEngine,
    auditRepo,
    merchantRepo,
    server,
    eventEmitter
  });

  const context = {
    db,
    merchantRepo,
    accountRepo,
    customerRepo,
    customerSessionRepo,
    sessionRepo,
    deviceRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    queueEngine,
    timingEngine,
    attributionEngine,
    pipeline,
    recoveryEngine,
    eventEmitter,
    defaultMerchant,
    checkoutBaseUrl,
    whatsappBerryService,
    webhookEngine,
    observerPollerService,
    otpCooldownMs: options.otpCooldownMs
  };

  registerPaymentRoutes(server, context);
  registerCheckoutRoutes(server, context);
  registerPollerRoutes(server, context);
  registerAdminRoutes(server, context);
  registerCustomerRoutes(server, context);
  registerDeviceRoutes(server, context);

  async function destroy() {
    clearInterval(queueSyncDaemon);
    clearInterval(webhookRetryDaemon);
    observerPollerService.destroy();
    await timingEngine.destroy();
    if (typeof attributionEngine.destroy === 'function') {
      await attributionEngine.destroy();
    }
    if (whatsappBerryService && typeof whatsappBerryService.disconnect === 'function') {
      whatsappBerryService.disconnect({ cleanSession: false }).catch(() => {});
    }
  }

  return {
    server,
    context,
    destroy,
    rawServer: server.createServer()
  };
}

export async function startServer(port = null, customDb = null) {
  const finalPort = port || Number(process.env.PAYMENT_API_PORT || 6100);
  const app = await createPaymentApp(customDb);

  return new Promise(resolve => {
    const bindHost = process.env.YOUPI_BIND_HOST || '127.0.0.1';
    const instance = app.rawServer.listen(finalPort, bindHost, () => {
      console.log(`[Payment API] Server listening on port ${finalPort}`);
      resolve({
        app,
        port: finalPort,
        close: async () => {
          await app.destroy();
          await new Promise(cb => instance.close(cb));
        }
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startServer();
  } catch (err) {
    if (err?.name === 'MigrationsRequiredError') {
      console.error(`[youpi] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
