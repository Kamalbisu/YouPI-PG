import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpServer } from '../server.js';
import { BankSmsParser, generateQrSvg } from '@youpi/core';
import { toRupeesString, toPaise, verifyHmac, resolveRuntimeUrls, resolveSecret, safeEqual, hasBearer, getObserverToken, isAllowedNotificationPackage, encryptAtRest, decryptAtRest } from '@youpi/common';
import { isAdminRequest } from '../auth-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_OBSERVATION_TEXT_CHARS = 64 * 1024;

const MAX_DEVICE_BODY_BYTES = 64 * 1024;

const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PAIRING_TOKENS = 1000;

const SIGNATURE_REPLAY_WINDOW_MS = 120 * 1000;
const seenSignatures = new Map();
const MAX_SEEN_SIGNATURES = 10000;

function isReplayedSignature(deviceId, signature) {
  const now = Date.now();
  if (seenSignatures.size >= MAX_SEEN_SIGNATURES) {
    for (const [key, at] of seenSignatures) {
      if (now - at > SIGNATURE_REPLAY_WINDOW_MS) seenSignatures.delete(key);
    }
    while (seenSignatures.size >= MAX_SEEN_SIGNATURES) {
      seenSignatures.delete(seenSignatures.keys().next().value);
    }
  }
  const key = `${deviceId}:${signature}`;
  const previous = seenSignatures.get(key);
  if (previous !== undefined && now - previous <= SIGNATURE_REPLAY_WINDOW_MS) return true;
  seenSignatures.set(key, now);
  return false;
}

export function registerPollerRoutes(server, ctx) {
  const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');

  const pairingTokens = new Map();
  const issuePairingToken = (merchantId) => {
    const now = Date.now();
    for (const [t, v] of pairingTokens) if (v.expiresAt <= now) pairingTokens.delete(t);
    while (pairingTokens.size >= MAX_PENDING_PAIRING_TOKENS) {
      pairingTokens.delete(pairingTokens.keys().next().value);
    }
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = now + PAIRING_TOKEN_TTL_MS;
    pairingTokens.set(token, { merchantId, expiresAt });
    return { token, expiresAt };
  };
  const consumePairingToken = (token) => {
    const entry = pairingTokens.get(token);
    if (!entry) return null;
    pairingTokens.delete(token);
    return entry.expiresAt > Date.now() ? entry : null;
  };

  server.get('/api/v1/pollers/active-window', async (req, res) => {
    if (!isAdminRequest(req) && !hasBearer(req, getObserverToken())) {
      HttpServer.json(res, 401, { error: 'Unauthorized', code: 'AUTH_REQUIRED' });
      return;
    }
    const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
    const activeSessions = ctx.db.query(`
      SELECT id, order_id, receiving_account_id, amount_paise, status, verification_level, expires_at, processing_expires_at, completed_at
      FROM payment_sessions
      WHERE status IN ('ACTIVE', 'PROCESSING')
         OR (status = 'SUCCESS' AND verification_level < 2 AND completed_at >= ?)
      ORDER BY created_at DESC
    `, [sixtySecsAgo]);

    const sessions = activeSessions.map(s => ({
      id: s.id,
      orderId: s.order_id,
      receivingAccountId: s.receiving_account_id,
      amount: toRupeesString(s.amount_paise),
      amountPaise: Number(s.amount_paise),
      status: s.status,
      verificationLevel: s.verification_level || 0,
      expiresAt: s.expires_at,
      processingExpiresAt: s.processing_expires_at
    }));

    HttpServer.json(res, 200, {
      hasActivePayment: sessions.length > 0,
      sessions
    });
  });

  server.post('/api/v1/pollers/events', async (req, res) => {
    const body = await HttpServer.parseBody(req);

    if (!body.receivingAccountId || !body.source) {
      HttpServer.json(res, 400, { error: 'Missing required fields: receivingAccountId and source.' });
      return;
    }

    const rawText = body.rawText || body.text || body.message || body.sms || body.body || (typeof body.rawPayload === 'string' ? body.rawPayload : (body.rawPayload?.text || body.rawPayload?.body));
    const sender = body.sender || body.from || body.rawPayload?.sender || body.rawPayload?.from;

    if (!rawText || (typeof rawText === 'string' && !rawText.trim())) {
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: 'MISSING_RAW_TEXT',
        error: 'Observation rawText is required for verification.'
      });
      return;
    }

    if (typeof rawText === 'string' && rawText.length > MAX_OBSERVATION_TEXT_CHARS) {
      HttpServer.json(res, 413, { error: `Observation body too large (max ${MAX_OBSERVATION_TEXT_CHARS} characters).` });
      return;
    }

    if (!ctx.pipeline) {
      HttpServer.json(res, 500, { error: 'Verification pipeline is not configured on this server.' });
      return;
    }

    const pipeResult = ctx.pipeline.process({
      source: body.source,
      rawText,
      sender,
      receivingAccountId: body.receivingAccountId,
      paymentSessionId: body.paymentSessionId,
      bankReferenceNumber: body.bankReferenceNumber || body.utr,
      isTest: Boolean(body.isTest) && isAdminRequest(req),
      testModeActive: Boolean(body.testModeActive) && isAdminRequest(req)
    });

    if (pipeResult.status === 'REJECTED' && pipeResult.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        accepted: false,
        status: 'REJECTED',
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        threatDetected: true,
        banned: true,
        error: 'FRAUDULENT_PAYMENT_INJECTION: Positive identification of fake payment message. Customer account banned and session terminated.'
      });
      return;
    }

    if (pipeResult.status === 'VERIFIED') {
      HttpServer.json(res, 200, {
        accepted: true,
        observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
        attribution: pipeResult.stages?.stage6?.details || pipeResult,
        pipeline: pipeResult
      });
      return;
    }

    if (pipeResult.status === 'REJECTED') {
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: pipeResult.failingCondition,
        error: pipeResult.failingReason || pipeResult.details,
        pipeline: pipeResult
      });
      return;
    }

    if (
      pipeResult.failingStage === 4 &&
      pipeResult.failingCondition === 'NO_ACTIVE_SESSION' &&
      ctx.sessionRepo && ctx.attributionEngine
    ) {
      const liveSession = ctx.sessionRepo.findCurrentActiveOrProcessing(body.receivingAccountId);
      if (!liveSession) {
        try {
          const lateResult = ctx.attributionEngine.processObservation({
            source: body.source,
            receivingAccountId: body.receivingAccountId,
            amountPaise: pipeResult.amountPaise,
            bankReferenceNumber: pipeResult.reference || body.utr || body.bankReferenceNumber,
            observedAt: new Date(body.observedAt || Date.now()),
            sender,
            rawPayload: body.rawPayload || { text: rawText }
          });
          HttpServer.json(res, 200, {
            accepted: false,
            status: lateResult?.outcomeStatus || 'LATE_UNMATCHED',
            reason: 'LATE_OBSERVATION_NO_ACTIVE_SESSION',
            observationId: lateResult?.observationId || pipeResult.messageId,
            error: 'Payment credit was received after the session ended and has been queued for manual reconciliation.',
            pipeline: pipeResult
          });
        } catch (err) {
          HttpServer.json(res, 400, {
            accepted: false,
            status: 'UNRESOLVED',
            reason: pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
            error: 'Payment observation could not be verified or attributed.'
          });
        }
        return;
      }
    }

    HttpServer.json(res, 400, {
      accepted: false,
      status: pipeResult.status || 'UNRESOLVED',
      reason: pipeResult.stages?.stage6?.outcomeStatus || pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
      observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
      error: pipeResult.failingReason || 'Payment observation could not be verified or attributed.',
      pipeline: pipeResult
    });
  });

  const handleAndroidPair = async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const token = body.enrollmentToken || body.token;
    let merchantId = body.merchantId || '00000000-0000-0000-0000-000000000001';
    const deviceName = body.deviceName || 'Android SMS Gateway';
    const deviceModel = body.deviceModel || 'Android Device';

    const oneTime = token ? consumePairingToken(String(token)) : null;
    if (oneTime) {
      merchantId = oneTime.merchantId;
    } else if (!token || !safeEqual(String(token), enrollmentSecret)) {
      HttpServer.json(res, 401, { error: 'Invalid or expired device pairing enrollment token.' });
      return;
    }

    if (body.expiresAt && Date.now() > Number(body.expiresAt)) {
      HttpServer.json(res, 400, { error: 'PAIRING QR EXPIRED' });
      return;
    }

    if (body.version && body.version !== 'v1') {
      HttpServer.json(res, 400, { error: 'INVALID YOUPI PAIRING QR' });
      return;
    }

    const deviceId = crypto.randomUUID();
    const signingKey = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date().toISOString();

    try {
      ctx.db.execute(`
        INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, last_heartbeat_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `, [deviceId, merchantId, deviceName, deviceModel, encryptAtRest(signingKey), nowIso, nowIso]);

      if (ctx.auditRepo) {
        ctx.auditRepo.log({
          merchantId,
          entityType: 'ANDROID_DEVICE',
          entityId: deviceId,
          action: 'SMS_GATEWAY_DEVICE_PAIRED',
          actorType: 'ADMIN',
          details: { deviceName, deviceModel }
        });
      }

      HttpServer.json(res, 200, {
        paired: true,
        deviceId,
        signingKey,
        merchantId,
        message: 'Android SMS Gateway paired successfully.'
      });
    } catch (err) {
      HttpServer.json(res, 500, { error: `Failed to register Android device: ${err.message}` });
    }
  };

  server.post('/api/v1/pollers/android/pair', handleAndroidPair);
  server.post('/api/v1/observers/sms/pair', handleAndroidPair);

  const handleAndroidSmsEvents = async (req, res, { requirePackage = false } = {}) => {
    let rawBodyText;
    try {
      rawBodyText = await new Promise((resolve, reject) => {
        let data = '';
        let size = 0;
        let exceeded = false;
        req.on('data', chunk => {
          if (exceeded) return;
          size += chunk.length;
          if (size > MAX_DEVICE_BODY_BYTES) {
            exceeded = true;
            data = '';
            reject(new Error('Payload Too Large'));
            return;
          }
          data += chunk;
        });
        req.on('end', () => { if (!exceeded) resolve(data); });
        req.on('error', reject);
      });
    } catch {
      HttpServer.json(res, 413, { error: 'Payload too large.' });
      return;
    }

    let body = {};
    try {
      body = JSON.parse(rawBodyText);
    } catch {
      HttpServer.json(res, 400, { error: 'Invalid JSON payload.' });
      return;
    }

    const deviceId = req.headers['x-device-id'] || body.deviceId;
    if (!deviceId) {
      HttpServer.json(res, 400, { error: 'Missing required X-Device-Id header or deviceId.' });
      return;
    }

    const device = ctx.db.queryOne('SELECT * FROM android_devices WHERE id = ? AND is_active = 1', [deviceId]);
    if (!device) {
      HttpServer.json(res, 403, { error: 'Device not authorized or inactive.' });
      return;
    }

    const timestampStr = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];

    if (!device.signing_key_hash || !timestampStr || !signature) {
      HttpServer.json(res, 401, { error: 'Missing X-Timestamp / X-Signature headers.' });
      return;
    }

    {
      const ts = Number(timestampStr);
      const now = Date.now();
      if (isNaN(ts) || Math.abs(now - ts) > 60000) {
        HttpServer.json(res, 401, { error: 'Timestamp drift exceeded validity window (replay protection triggered).' });
        return;
      }

      const sigPayload = `${rawBodyText}:${timestampStr}`;
      const signingKey = decryptAtRest(device.signing_key_hash);
      const isValid = signingKey ? verifyHmac(sigPayload, signingKey, String(signature)) : false;
      if (!isValid) {
        HttpServer.json(res, 401, { error: 'Invalid cryptographic HMAC signature.' });
        return;
      }
      if (isReplayedSignature(device.id, String(signature))) {
        HttpServer.json(res, 401, { error: 'Request signature already used (replay protection triggered).' });
        return;
      }
    }

    let receivingAccountId = body.receivingAccountId;
    if (receivingAccountId) {
      const owned = ctx.db.queryOne(
        'SELECT id FROM payment_receiving_accounts WHERE id = ? AND merchant_id = ?',
        [String(receivingAccountId), device.merchant_id]
      );
      if (!owned) {
        HttpServer.json(res, 403, { accepted: false, error: 'receivingAccountId does not belong to this device\'s merchant.' });
        return;
      }
    } else {
      const activeAccount = ctx.accountRepo
        ? ctx.accountRepo.findActiveForMerchant(device.merchant_id)
        : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [device.merchant_id]);
      receivingAccountId = activeAccount?.id || '00000000-0000-0000-0000-000000000002';
    }

    let amountPaise;
    if (body.amountPaise) {
      try {
        amountPaise = BigInt(body.amountPaise);
      } catch {
        HttpServer.json(res, 400, { accepted: false, error: 'amountPaise must be an integer number of paise.' });
        return;
      }
      if (amountPaise <= 0n) {
        HttpServer.json(res, 400, { accepted: false, error: 'amountPaise must be positive.' });
        return;
      }
    }
    let bankRef = body.bankReferenceNumber || body.utr;
    let senderVpa = body.senderVpa;
    let observedAt = body.observedAt ? new Date(body.observedAt) : new Date();

    const rawPkg = body.rawNotification?.package;
    if (requirePackage) {
      if (!rawPkg || typeof rawPkg !== 'string' || !rawPkg.trim()) {
        HttpServer.json(res, 400, {
          accepted: false,
          error: 'Android notification observation must specify a valid package name in rawNotification.package'
        });
        return;
      }
    }

    if (rawPkg && typeof rawPkg === 'string' && rawPkg.trim()) {
      const notificationPackage = rawPkg.trim().toLowerCase();
      if (!isAllowedNotificationPackage(notificationPackage)) {
        HttpServer.json(res, 400, {
          accepted: false,
          error: `Untrusted Android notification package: ${notificationPackage}`
        });
        return;
      }
    }

    const rawText = body.body || body.sms || body.rawSms || body.message || body.text || body.rawNotification?.text;
    if (!rawText || (typeof rawText === 'string' && !rawText.trim())) {
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: 'MISSING_RAW_TEXT',
        error: 'Observation rawText is required for verification.'
      });
      return;
    }

    if (rawText && (!amountPaise || !bankRef)) {
      const parsedSms = BankSmsParser.parse({
        text: rawText,
        sender: body.sender || body.rawNotification?.package,
        timestamp: observedAt
      });

      if (parsedSms) {
        if (!amountPaise) amountPaise = parsedSms.amountPaise;
        if (!bankRef && parsedSms.bankReferenceNumber) bankRef = parsedSms.bankReferenceNumber;
        if (!senderVpa && parsedSms.senderVpa) senderVpa = parsedSms.senderVpa;
      }
    }

    if (!amountPaise && body.amount) {
      try {
        amountPaise = toPaise(body.amount);
      } catch {}
    }

    if (!ctx.pipeline) {
      HttpServer.json(res, 500, { error: 'Verification pipeline is not configured on this server.' });
      return;
    }

    const pipeResult = ctx.pipeline.process({
      source: 'SMS',
      rawText,
      sender: body.sender || req.headers['x-sender'] || body.rawNotification?.package,
      receivingAccountId,
      paymentSessionId: body.paymentSessionId,
      bankReferenceNumber: bankRef,
      isTest: false,
      deviceInfo: device ? `${device.device_name} (${device.device_model})` : 'Android SMS Gateway'
    });

    if (pipeResult.status === 'REJECTED' && pipeResult.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        accepted: false,
        status: 'REJECTED',
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        threatDetected: true,
        banned: true,
        error: 'FRAUDULENT_PAYMENT_INJECTION: Fake SMS detected. Associated customer identity banned and session terminated.'
      });
      return;
    }

    if (pipeResult.status === 'VERIFIED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 200, {
        accepted: true,
        observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
        attribution: pipeResult.stages?.stage6?.details || pipeResult,
        pipeline: pipeResult
      });
      return;
    }

    if (pipeResult.status === 'REJECTED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: pipeResult.failingCondition,
        error: pipeResult.failingReason || pipeResult.details,
        pipeline: pipeResult
      });
      return;
    }

    if (!amountPaise && pipeResult.status === 'UNRESOLVED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 200, {
        accepted: true,
        status: 'PROCESSED_NON_BANK',
        bankMatch: false,
        message: 'Raw SMS observation ingested and evaluated by server pipeline.'
      });
      return;
    }

    ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
    HttpServer.json(res, 400, {
      accepted: false,
      status: pipeResult.status || 'UNRESOLVED',
      reason: pipeResult.stages?.stage6?.outcomeStatus || pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
      observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
      error: pipeResult.failingReason || 'Payment observation could not be verified or attributed.',
      pipeline: pipeResult
    });
  };

  server.post('/api/v1/pollers/android/events', (req, res) => handleAndroidSmsEvents(req, res, { requirePackage: true }));
  server.post('/api/v1/observers/sms', (req, res) => handleAndroidSmsEvents(req, res, { requirePackage: false }));

  const handleAndroidHeartbeat = async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const deviceId = req.headers['x-device-id'] || body.deviceId;

    if (deviceId && typeof deviceId === 'string') {
      ctx.db.execute('UPDATE android_devices SET last_heartbeat_at = datetime(\'now\') WHERE id = ?', [deviceId]);
    }

    HttpServer.json(res, 200, {
      status: 'HEARTBEAT_ACK',
      timestamp: Date.now()
    });
  };

  server.post('/api/v1/pollers/android/heartbeat', handleAndroidHeartbeat);
  server.post('/api/v1/pollers/heartbeat', handleAndroidHeartbeat);
  server.post('/api/v1/observers/heartbeat', handleAndroidHeartbeat);

  server.get('/api/v1/admin/sms-gateway/pair-qr', async (req, res) => {
    let merchant = req.query.merchantId ? (ctx.merchantRepo ? ctx.merchantRepo.findById(req.query.merchantId) : null) : null;
    if (!merchant && ctx.merchantRepo) merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    const merchantId = merchant ? merchant.id : (req.query.merchantId || '00000000-0000-0000-0000-000000000001');

    const runtime = resolveRuntimeUrls(merchant?.branding || {});
    const baseUrl = runtime.apiUrl;
    const { token, expiresAt } = issuePairingToken(merchantId);
    const sessionId = crypto.randomUUID();

    const pairingPayloadObj = {
      version: 'v1',
      type: 'YOUPI_SMS_GATEWAY_PAIR',
      serverUrl: baseUrl,
      gatewayUrl: baseUrl,
      apiBaseUrl: baseUrl,
      sessionId,
      token,
      enrollmentToken: token,
      merchantId,
      createdAt: Date.now(),
      expiresAt
    };

    const pairingPayload = JSON.stringify(pairingPayloadObj);
    const qrSvg = generateQrSvg(pairingPayload, 260);

    const rawDevices = ctx.db.query(`
      SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at
      FROM android_devices
      WHERE merchant_id = ? OR merchant_id = '00000000-0000-0000-0000-000000000001'
      ORDER BY created_at DESC
    `, [merchantId]);

    const devices = (rawDevices || []).map(d => ({
      id: d.id,
      deviceId: d.id,
      deviceName: d.device_name || d.device_model || 'Android Observer',
      device_name: d.device_name || d.device_model || 'Android Observer',
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_at,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_at,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at
    }));

    HttpServer.json(res, 200, {
      qrSvg,
      pairingQrSvg: qrSvg,
      pairingPayload,
      payload: pairingPayloadObj,
      sessionId,
      expiresAt,
      version: 'v1',
      token,
      enrollmentToken: token,
      gatewayUrl: baseUrl,
      serverUrl: baseUrl,
      devices
    });
  });

  server.get('/api/v1/admin/sms-gateway/devices', async (req, res) => {
    let merchant = req.query.merchantId ? (ctx.merchantRepo ? ctx.merchantRepo.findById(req.query.merchantId) : null) : null;
    if (!merchant && ctx.merchantRepo) merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    const merchantId = merchant ? merchant.id : (req.query.merchantId || '00000000-0000-0000-0000-000000000001');

    const rawDevices = ctx.db.query(`
      SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at
      FROM android_devices
      WHERE merchant_id = ? OR merchant_id = '00000000-0000-0000-0000-000000000001'
      ORDER BY created_at DESC
    `, [merchantId]);

    const devices = (rawDevices || []).map(d => ({
      id: d.id,
      deviceId: d.id,
      deviceName: d.device_name || d.device_model || 'Android Observer',
      device_name: d.device_name || d.device_model || 'Android Observer',
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_at,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_at,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at
    }));

    HttpServer.json(res, 200, { devices });
  });

  server.delete('/api/v1/admin/sms-gateway/devices/:deviceId', async (req, res, params) => {
    const deviceId = params.deviceId;
    ctx.db.execute('DELETE FROM android_devices WHERE id = ?', [deviceId]);
    HttpServer.json(res, 200, { success: true, message: 'Device unlinked.' });
  });

  const serveApk = async (req, res) => {
    const apkLocations = [
      path.resolve(__dirname, '../../public/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../merchant-admin/public/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../android-observer-app/app/build/outputs/apk/release/youpi-sms-gateway.apk'),
      path.resolve(__dirname, '../../../android-observer-app/youpi-sms-gateway.apk')
    ];

    let foundPath = null;
    for (const p of apkLocations) {
      if (fs.existsSync(p)) {
        foundPath = p;
        break;
      }
    }

    if (!foundPath) {
      HttpServer.json(res, 404, { error: 'APK_NOT_BUILT', message: 'The Android observer APK has not been built or installed on this server.' });
      return;
    }

    const stat = fs.statSync(foundPath);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(foundPath).pipe(res);
  };

  server.get('/api/v1/admin/sms-gateway/download-apk', serveApk);
  server.get('/youpi-sms-gateway.apk', serveApk);
}
