import { HttpServer } from '../server.js';
import { toRupeesString, buildUpiUri, PaymentStatus, PaymentMethod, UPI_PROVIDERS, isInternalServiceRequest, isValidTransition, getObserverToken } from '@youpi/common';
import { validateSessionDeviceAccess, verifyRegisteredDeviceCredentials } from '@youpi/core';
import { isAdminRequest, isPaymentOwner } from '../auth-guard.js';

async function checkSessionDeviceAccess(session, req, body = null, ctx = null) {
  if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED, PaymentStatus.SUSPICIOUS].includes(session.status)) {
    return { allowed: true, boundDeviceId: session.deviceId, isTerminal: true };
  }

  if (isInternalServiceRequest(req) || isAdminRequest(req)) {
    return { allowed: true, boundDeviceId: session.deviceId };
  }

  const requestingDeviceId = req.headers['x-device-id'] ||
    body?.deviceId ||
    (req.query && req.query.deviceId) ||
    null;
  const deviceToken = req.headers['x-device-token'] ||
    body?.deviceToken ||
    (req.query && req.query.deviceToken) ||
    null;
  const deviceSignature = req.headers['x-device-signature'] ||
    body?.deviceSignature ||
    null;
  const signaturePayload = req.headers['x-device-payload'] ||
    body?.signaturePayload ||
    null;

  if (!session.deviceId) {
    if (requestingDeviceId) {
      const credCheck = await verifyRegisteredDeviceCredentials({
        deviceId: requestingDeviceId,
        deviceToken,
        deviceSignature,
        signaturePayload,
        deviceRepo: ctx?.deviceRepo
      });
      if (!credCheck.valid) {
        return {
          allowed: false,
          statusCode: 409,
          body: {
            error: credCheck.error === 'DEVICE_SIGNATURE_INVALID' ? 'DEVICE_SIGNATURE_INVALID' : 'DUPLICATE_SESSION_DETECTED',
            code: credCheck.error,
            session_id: session.id,
            conflicting_session_id: session.id,
            action: 'END_SESSION_AND_CREATE_NEW',
            message: credCheck.message || 'Unregistered or unverified device identity.',
            boundDeviceId: null,
            requestingDeviceId
          }
        };
      }
      if (ctx?.deviceRepo) {
        await ctx.deviceRepo.touch(requestingDeviceId);
      }
      if (ctx?.sessionRepo) {
        try {
          await ctx.sessionRepo.bindDevice(session.id, requestingDeviceId);
          session.deviceId = requestingDeviceId;
        } catch (err) {
          console.warn('[checkSessionDeviceAccess] bindDevice error:', err.message);
        }
      }
    }
    return { allowed: true, boundDeviceId: session.deviceId };
  }

  const validation = await validateSessionDeviceAccess({
    session,
    requestingDeviceId,
    deviceToken,
    deviceSignature,
    signaturePayload,
    deviceRepo: ctx?.deviceRepo
  });

  if (!validation.allowed) {
    return {
      allowed: false,
      statusCode: 409,
      body: {
        ...validation,
        conflicting_session_id: session.id
      }
    };
  }

  if (ctx?.deviceRepo) {
    await ctx.deviceRepo.touch(session.deviceId);
  }
  return { allowed: true, boundDeviceId: session.deviceId };
}

function sanitizePublicBranding(raw = {}) {
  return {
    appName: raw.appName || 'YOUPI PG',
    primaryColor: raw.primaryColor || '#2563eb',
    headerTheme: raw.headerTheme || 'gradient',
    logoUrl: raw.logoUrl || null,
    counterInstructions: raw.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.',
    cardCounterInstructions: raw.cardCounterInstructions || 'Please swipe, insert, or tap your credit or debit card on the store POS terminal at the billing desk.',
    supportEmails: Array.isArray(raw.supportEmails) ? raw.supportEmails : [],
    supportMobiles: Array.isArray(raw.supportMobiles) ? raw.supportMobiles : [],
    privacyPolicyUrl: raw.privacyPolicyUrl || null,
    termsUrl: raw.termsUrl || null,
    sellingMode: raw.sellingMode || 'ONLINE',
    customCss: raw.customCss || null,
    enabledPaymentMethods: Array.isArray(raw.enabledPaymentMethods) ? raw.enabledPaymentMethods : ['UPI'],
    sidebarNotice: raw.sidebarNotice || undefined,
    checkoutNotice: raw.checkoutNotice || undefined,
    footerGuarantee: raw.footerGuarantee || undefined,
    trustBadgeText: raw.trustBadgeText || undefined,
    hideTrustBadge: raw.hideTrustBadge !== undefined ? Boolean(raw.hideTrustBadge) : undefined,
    subbannerText: raw.subbannerText || undefined,
    hideSubbanner: raw.hideSubbanner !== undefined ? Boolean(raw.hideSubbanner) : undefined,
    hidePoweredBy: raw.hidePoweredBy !== undefined ? Boolean(raw.hidePoweredBy) : undefined,
    hideTimeSavingBanner: raw.hideTimeSavingBanner !== undefined ? Boolean(raw.hideTimeSavingBanner) : undefined
  };
}

async function checkUpiServerHealth(ctx, enabledMethods = [], sellingMode = 'OFFLINE', merchantId = '00000000-0000-0000-0000-000000000001') {
  try {
    const merchant = ctx.merchantRepo?.findById ? await ctx.merchantRepo.findById(merchantId) : null;
    const falseNarrativeUntil = merchant?.branding?.falseNarrativeUntil;
    const falseNarrativeMode = (merchant?.branding?.falseNarrativeMode || 'GREEN').toUpperCase();
    if (falseNarrativeUntil && Number(falseNarrativeUntil) > Date.now()) {
      const remainingSeconds = Math.max(0, Math.round((Number(falseNarrativeUntil) - Date.now()) / 1000));
      if (falseNarrativeMode === 'GREEN') {
        return {
          status: 'WORKING',
          tier: 'GREEN',
          label: 'Server Is Working',
          isWorking: true,
          reason: 'False Narrative Active (Dev Override: GREEN): UPI servers interpreted as operational',
          smsHealthy: true,
          gmailHealthy: true,
          warning: null,
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'GREEN',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      } else if (falseNarrativeMode === 'YELLOW') {
        return {
          status: 'BUSY',
          tier: 'YELLOW',
          label: 'UPI Server Busy',
          isWorking: true,
          reason: 'False Narrative Active (Dev Override: YELLOW): UPI servers experiencing processing delays',
          smsHealthy: true,
          gmailHealthy: false,
          warning: 'Your payment may go through extra processing seconds.',
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'YELLOW',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      } else if (falseNarrativeMode === 'RED') {
        return {
          status: 'ISSUES',
          tier: 'RED',
          label: 'Server Facing Issues',
          isWorking: false,
          reason: 'False Narrative Active (Dev Override: RED): UPI servers facing downtime',
          smsHealthy: false,
          gmailHealthy: false,
          warning: 'It is not recommended to pay by UPI right now as the server is facing downtime.',
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'RED',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      }
    }
  } catch (err) {}

  let smsHealthy = false;
  let gmailHealthy = false;
  let smsReason = 'SMS gateway disconnected';
  let gmailReason = 'Gmail OAuth unconfigured';

  try {
    if (ctx.db) {
      const activeAndroid = await ctx.db.queryOne(`
        SELECT id, device_name, last_heartbeat_at
        FROM android_devices
        WHERE is_active = true AND last_heartbeat_at >= now() - interval '5 minutes'
        LIMIT 1
      `);
      if (activeAndroid) {
        smsHealthy = true;
        smsReason = `Android SMS Gateway Active (${activeAndroid.device_name || 'Enrolled Device'})`;
      }
    }
  } catch (err) {}

  if (!smsHealthy) {
    try {
      const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);
      const res = await fetch(`http://127.0.0.1:${smsPort}/api/browser/status`, {
          headers: { 'Authorization': `Bearer ${getObserverToken()}` },
          signal: AbortSignal.timeout(800)
        });
      if (res.ok) {
        const data = await res.json();
        const isRecent = data.lastSeenAt && (Date.now() - new Date(data.lastSeenAt).getTime() < 300000);
        if (data.isPaired === true && data.status === 'CONNECTED' && data.mode === 'BACKGROUND' && (data.isPolling === true || isRecent)) {
          smsHealthy = true;
          smsReason = 'Google Messages SMS Gateway active & paired';
        }
      }
    } catch (err) {}
  }

  try {
    const merchant = ctx.merchantRepo?.findById ? await ctx.merchantRepo.findById(merchantId) : null;
    const gmailConfig = merchant?.branding?.gmailConfig || {};
    const hasRefreshToken = Boolean(gmailConfig.refreshToken && gmailConfig.refreshToken.trim());
    const hasApiKey = Boolean(gmailConfig.apiKey && gmailConfig.apiKey.trim());

    if (hasRefreshToken || hasApiKey) {
      let pollerActive = false;
      const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);

      try {
        const res = await fetch(`http://127.0.0.1:${gmailPort}/health`, { signal: AbortSignal.timeout(800) });
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'UP') {
            pollerActive = true;
          }
        }
      } catch (e) {}

      if (!pollerActive) {
        try {
          const res = await fetch(`http://127.0.0.1:${gmailPort}/api/browser/status`, {
          headers: { 'Authorization': `Bearer ${getObserverToken()}` },
          signal: AbortSignal.timeout(800)
        });
          if (res.ok) {
            const data = await res.json();
            if (data.isLoggedIn || data.status === 'CONNECTED' || data.isPolling) {
              pollerActive = true;
            }
          }
        } catch (e) {}
      }

      if (!pollerActive) {
        try {
          const res = await fetch(`http://127.0.0.1:6099/health`, { signal: AbortSignal.timeout(800) });
          if (res.ok) {
            const data = await res.json();
            if (data.status === 'UP' && (data.isPolling || data.pollerActive !== false)) {
              pollerActive = true;
            }
          }
        } catch (e) {}
      }

      if (pollerActive || hasRefreshToken) {
        gmailHealthy = true;
        gmailReason = 'Gmail OAuth connected and actively polling';
      } else {
        gmailReason = 'Gmail OAuth configured but observer service is offline';
      }
    } else {
      try {
        const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
        const res = await fetch(`http://127.0.0.1:${gmailPort}/api/browser/status`, {
          headers: { 'Authorization': `Bearer ${getObserverToken()}` },
          signal: AbortSignal.timeout(800)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.isLoggedIn === true && data.status === 'CONNECTED') {
            gmailHealthy = true;
            gmailReason = 'Gmail browser automator logged in';
          }
        }
      } catch (e) {}

      if (!gmailHealthy) {
        gmailReason = 'Gmail OAuth not configured';
      }
    }
  } catch (err) {
    gmailReason = `Gmail check error: ${err.message}`;
  }

  const hasCash = sellingMode === 'ONLINE'
    ? enabledMethods.includes('COD')
    : enabledMethods.includes('CASH_COUNTER');

  if (smsHealthy && gmailHealthy) {
    return {
      status: 'WORKING',
      tier: 'GREEN',
      label: 'Server Is Working',
      isWorking: true,
      reason: 'All observers active: Gmail OAuth polling & SMS Gateway connected',
      smsHealthy: true,
      gmailHealthy: true,
      warning: null,
      recommendedAlternative: null
    };
  }

  if (smsHealthy || gmailHealthy) {
    return {
      status: 'BUSY',
      tier: 'YELLOW',
      label: 'UPI Server Busy',
      isWorking: true,
      reason: smsHealthy ? 'SMS observer active, Gmail observer offline' : 'Gmail observer active, SMS observer offline',
      smsHealthy,
      gmailHealthy,
      warning: 'Your payment may go through extra processing seconds.',
      recommendedAlternative: null
    };
  }

  return {
    status: 'ISSUES',
    tier: 'RED',
    label: 'Server Facing Issues',
    isWorking: false,
    reason: 'Both Gmail OAuth and SMS Gateway are offline or unconfigured',
    smsHealthy: false,
    gmailHealthy: false,
    warning: 'It is not recommended to pay by UPI right now as the server is facing downtime. We recommend paying by cash instead.',
    recommendedAlternative: hasCash ? 'CASH' : null
  };
}

export function registerCheckoutRoutes(server, ctx) {
  server.get('/api/v1/checkout/:id/state', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Checkout session not found: ${params.id}` });
      return;
    }

    const isCustomerBanned = session.customerId && ctx.customerRepo && await ctx.customerRepo.isBanned(session.customerId);
    const isSessionBlocked = session.status === 'BLOCKED' || (session.metadata?.banReason === 'FRAUDULENT_PAYMENT_INJECTION');

    if (isCustomerBanned || isSessionBlocked) {
      const cust = session.customerId ? await ctx.customerRepo.findById(session.customerId) : null;
      HttpServer.json(res, 200, {
        id: session.id,
        orderId: session.orderId,
        amount: toRupeesString(session.amountPaise),
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        customerName: cust?.name || 'Customer',
        blockedNotice: {
          title: 'FRAUDULENT ACTIVITY DETECTED',
          subtitle: 'Payment Session Terminated & Account Suspended',
          message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
          investigating: true,
          reason: cust?.banReason || 'FRAUDULENT_PAYMENT_INJECTION'
        }
      });
      return;
    }

    const now = Date.now();
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt && session.expiresAt.getTime() <= now) {
      await ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED);
      session.status = PaymentStatus.EXPIRED;
      if (session.receivingAccountId) {
        await ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
    } else if (session.status === PaymentStatus.PROCESSING && session.processingExpiresAt && session.processingExpiresAt.getTime() <= now) {
      await ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.FAILED);
      session.status = PaymentStatus.FAILED;
      if (session.receivingAccountId) {
        await ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.FAILED });
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      const merchant = await ctx.merchantRepo.findById(session.merchantId);
      const branding = sanitizePublicBranding(merchant?.branding || {});
      HttpServer.json(res, 200, {
        id: session.id,
        paymentId: session.id,
        orderId: session.orderId,
        amount: toRupeesString(session.amountPaise),
        amountPaise: session.amountPaise.toString(),
        currency: session.currency,
        status: session.status,
        timeRemainingSeconds: 0,
        isTerminal: true,
        returnUrl: session.returnUrl,
        branding
      });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    const merchant = await ctx.merchantRepo.findById(session.merchantId);
    const snapshot = session.metadata?.receivingAccountSnapshot;
    let receivingAccount = session.receivingAccountId
      ? await ctx.accountRepo.findById(session.receivingAccountId)
      : null;

    if (!receivingAccount && snapshot?.id) {
      receivingAccount = await ctx.accountRepo.findById(snapshot.id);
    }
    if (!receivingAccount && session.method === 'UPI') {
      receivingAccount = await ctx.accountRepo.findActiveForMerchant(session.merchantId);
    }

    const payeeVpa = snapshot?.upiId || receivingAccount?.upiId || null;
    const payeeName = snapshot?.payeeName || receivingAccount?.payeeName || merchant?.businessName || 'Merchant Store';
    const isMerchantEnabled = (snapshot?.isMerchantEnabled !== undefined)
      ? Boolean(snapshot.isMerchantEnabled)
      : (receivingAccount ? Boolean(receivingAccount.isMerchantEnabled) : true);
    const upiMode = isMerchantEnabled ? 'MERCHANT' : 'NON_MERCHANT';

    let timeRemainingSeconds = 0;
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - now) / 1000));
    } else if (session.status === PaymentStatus.PROCESSING && session.processingExpiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.processingExpiresAt.getTime() - now) / 1000));
    } else if (session.status === PaymentStatus.QUEUED) {
      timeRemainingSeconds = await ctx.queueEngine.calculateEstimatedWaitSeconds(
        session.receivingAccountId,
        session.queuePosition
      );
    }

    let upiUri = null;
    if (session.status === PaymentStatus.ACTIVE && payeeVpa) {
      try {
        upiUri = buildUpiUri({
          payeeVpa,
          payeeName,
          amountPaise: session.amountPaise,
          transactionRef: session.orderId,
          currency: session.currency || 'INR'
        });
      } catch {
        upiUri = null;
      }
    }

    const merchantBranding = merchant?.branding || {};
    const isCounterSession = session.method === 'CASH_COUNTER' || session.method === 'CARD_COUNTER';
    const sellingMode = merchantBranding.sellingMode || (isCounterSession ? 'OFFLINE' : 'ONLINE');
    const supportEmails = merchantBranding.supportEmails || (merchant?.contactEmail ? [merchant.contactEmail] : []);
    const supportMobiles = merchantBranding.supportMobiles || (merchant?.contactPhone ? [merchant.contactPhone] : []);
    const privacyPolicyUrl = merchantBranding.privacyPolicyUrl || null;

    let rawEnabled = merchantBranding.enabledPaymentMethods || (sellingMode === 'ONLINE' ? ['UPI'] : ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']);
    let enabledMethods = ['UPI'];
    if (sellingMode === 'ONLINE') {
      if (rawEnabled.includes('COD')) {
        enabledMethods.push('COD');
      }
    } else {
      if (rawEnabled.includes('CASH_COUNTER')) {
        enabledMethods.push('CASH_COUNTER');
      }
      if (rawEnabled.includes('CARD_COUNTER')) {
        enabledMethods.push('CARD_COUNTER');
      }
    }

    const branding = sanitizePublicBranding({
      ...merchantBranding,
      sellingMode,
      supportEmails,
      supportMobiles,
      privacyPolicyUrl,
      enabledPaymentMethods: enabledMethods
    });

    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-customer-token'] || null);

    const isOwnerCaller = await isPaymentOwner(req, session, ctx) || isInternalServiceRequest(req);
    const tokenAuth = (bearerToken && ctx.customerSessionRepo) ? await ctx.customerSessionRepo.findByToken(bearerToken) : null;
    const isSelfCaller = Boolean(tokenAuth?.customer && session.customerId && tokenAuth.customer.id === session.customerId);

    let customer = null;
    if (session.customerId && ctx.customerRepo && (isOwnerCaller || isSelfCaller)) {
      const c = await ctx.customerRepo.findById(session.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber,
          fullName: c.name,
          phoneNumber: c.mobileNumber
        };
      }
    } else if (!customer && tokenAuth?.customer) {
      const c = tokenAuth.customer;
      customer = {
        id: c.id,
        name: c.name,
        email: c.email,
        mobileNumber: c.mobileNumber,
        fullName: c.name,
        phoneNumber: c.mobileNumber
      };
    }

    const publicMetadata = isOwnerCaller ? (session.metadata || {}) : {};

    const requestingDeviceId = req.headers['x-device-id'] || null;
    let hasActiveSessionConflict = false;
    let conflictingSession = null;
    const conflictingActive = ctx.sessionRepo.findConflictingActiveSession
      ? await ctx.sessionRepo.findConflictingActiveSession({
          customerId: session.customerId,
          deviceId: requestingDeviceId || session.deviceId || null,
          excludeSessionId: session.id
        })
      : null;

    if (conflictingActive && conflictingActive.id !== session.id && [PaymentStatus.INITIATED, PaymentStatus.ACTIVE, PaymentStatus.QUEUED].includes(session.status)) {
      if (conflictingActive.deviceId && (!requestingDeviceId || requestingDeviceId !== conflictingActive.deviceId)) {
        HttpServer.json(res, 409, {
          error: 'DUPLICATE_SESSION_DETECTED',
          session_id: session.id,
          conflicting_session_id: conflictingActive.id,
          action: 'END_SESSION_AND_CREATE_NEW',
          message: 'This payment session was created on another device. For security reasons, this session cannot be continued from this device.',
          boundDeviceId: conflictingActive.deviceId,
          requestingDeviceId
        });
        return;
      }

      hasActiveSessionConflict = true;
      conflictingSession = {
        id: conflictingActive.id,
        paymentId: conflictingActive.id,
        orderId: conflictingActive.orderId,
        amount: toRupeesString(conflictingActive.amountPaise),
        status: conflictingActive.status,
        checkoutUrl: `/checkout/${conflictingActive.id}`
      };
    }

    if (session.status === PaymentStatus.ACTIVE) {
      if (payeeVpa && !upiUri) {
        try {
          upiUri = buildUpiUri({
            payeeVpa,
            payeeName,
            amountPaise: session.amountPaise,
            transactionRef: session.orderId,
            currency: session.currency || 'INR'
          });
        } catch {}
      }
      if (session.expiresAt) {
        timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - now) / 1000));
      }
    }

    const upiServerIndicator = await checkUpiServerHealth(ctx, enabledMethods, sellingMode, session.merchantId);

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      merchantName: merchant?.businessName || 'Merchant',
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      status: session.status,
      reason: session.metadata?.cancelledReason || null,
      cancelledReason: session.metadata?.cancelledReason || null,
      metadata: publicMetadata,
      method: session.method,
      verificationLevel: session.verificationLevel || 0,
      verificationSources: session.verificationSources || [],
      verificationTag: session.verificationTag || 'UNVERIFIED',
      sellingMode,
      enabledMethods,
      customer,
      hasActiveSessionConflict,
      conflictingSession,
      queuePosition: session.queuePosition || 0,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      serverNow: new Date().toISOString(),
      upiUri,
      payeeVpa,
      payeeName,
      isMerchantEnabled,
      upiMode,
      upiServerIndicator,
      receivingAccountId: receivingAccount?.id || snapshot?.id || null,
      providers: UPI_PROVIDERS,
      canClickPaymentDone: session.status === PaymentStatus.ACTIVE,
      returnUrl: session.returnUrl,
      supportEmails,
      supportMobiles,
      privacyPolicyUrl,
      deviceId: session.deviceId || null,
      branding
    });
  });

  server.get('/api/v1/checkout/server-health', async (req, res) => {
    const requestedMerchantId = String(req.query?.merchantId || '');
    const merchantId = /^[A-Za-z0-9_-]{1,64}$/.test(requestedMerchantId) ? requestedMerchantId : '00000000-0000-0000-0000-000000000001';
    const health = await checkUpiServerHealth(ctx, [], 'OFFLINE', merchantId);
    HttpServer.json(res, 200, health);
  });

  server.post('/api/v1/checkout/:id/bind-customer', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const token = body.token ||
      body.sessionToken ||
      req.headers['x-customer-token'] ||
      ((req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
    const { customerId } = body;

    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if (session.customerId && customerId && session.customerId !== customerId) {
      HttpServer.json(res, 409, {
        error: 'Payment session is already bound to another customer identity and cannot be mutated or reassigned.'
      });
      return;
    }

    if (!token || typeof token !== 'string' || !ctx.customerSessionRepo) {
      HttpServer.json(res, 401, {
        error: 'A valid customer session token is required to bind a customer identity.',
        code: 'CUSTOMER_SESSION_REQUIRED'
      });
      return;
    }

    const authContext = await ctx.customerSessionRepo.findByToken(token.trim());
    if (!authContext || !authContext.customer) {
      HttpServer.json(res, 401, {
        error: 'Invalid or expired customer session token.',
        code: 'CUSTOMER_SESSION_REQUIRED'
      });
      return;
    }

    const customer = authContext.customer;
    if (customerId && customerId !== customer.id) {
      HttpServer.json(res, 401, {
        error: 'Customer ID does not match authenticated session token.',
        code: 'CUSTOMER_SESSION_MISMATCH'
      });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    if (deviceAccess.boundDeviceId && ctx.deviceRepo) {
      try { await ctx.deviceRepo.associateCustomer(deviceAccess.boundDeviceId, customer.id); } catch {}
    }

    if (session.customerId && session.customerId !== customer.id) {
      HttpServer.json(res, 409, {
        error: 'Payment session is already bound to another customer identity and cannot be mutated or reassigned.'
      });
      return;
    }

    const otherActive = ctx.sessionRepo.findActiveForCustomer
      ? await ctx.sessionRepo.findActiveForCustomer(customer.id, params.id)
      : null;

    let hasActiveSessionConflict = false;
    let conflictingSession = null;
    if (otherActive && otherActive.id !== params.id) {
      hasActiveSessionConflict = true;
      conflictingSession = {
        id: otherActive.id,
        paymentId: otherActive.id,
        orderId: otherActive.orderId,
        amount: toRupeesString(otherActive.amountPaise),
        status: otherActive.status,
        checkoutUrl: `/checkout/${otherActive.id}`
      };
    }

    if (session.customerId === customer.id && session.status !== PaymentStatus.INITIATED) {
      HttpServer.json(res, 200, {
        success: true,
        status: session.status,
        queuePosition: session.queuePosition || 0,
        expiresAt: session.expiresAt,
        hasActiveSessionConflict,
        conflictingSession,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          mobileNumber: customer.mobileNumber,
          fullName: customer.name,
          phoneNumber: customer.mobileNumber
        }
      });
      return;
    }

    await ctx.db.execute(`
      UPDATE payment_sessions
      SET customer_id = ?, updated_at = ?
      WHERE id = ?
    `, [customer.id, new Date().toISOString(), params.id]);

    if (otherActive && otherActive.id !== params.id) {
      const requestingDeviceId = req.headers['x-device-id'] || body?.deviceId || null;
      if (otherActive.deviceId && (!requestingDeviceId || requestingDeviceId !== otherActive.deviceId)) {
        HttpServer.json(res, 409, {
          error: 'DUPLICATE_SESSION_DETECTED',
          session_id: params.id,
          conflicting_session_id: otherActive.id,
          action: 'END_SESSION_AND_CREATE_NEW',
          message: 'This customer already has an active payment session on another device. For security reasons, this session cannot be continued from this device.',
          boundDeviceId: otherActive.deviceId,
          requestingDeviceId
        });
        return;
      }

      hasActiveSessionConflict = true;
      conflictingSession = {
        id: otherActive.id,
        paymentId: otherActive.id,
        orderId: otherActive.orderId,
        amount: toRupeesString(otherActive.amountPaise),
        status: otherActive.status,
        checkoutUrl: `/checkout/${otherActive.id}`
      };
    }

    let queueResult = { status: session.status, queuePosition: session.queuePosition, expiresAt: session.expiresAt };
    const targetAccountId = session.receivingAccountId || (await ctx.accountRepo?.findActiveForMerchant(session.merchantId))?.id || session.metadata?.receivingAccountSnapshot?.id;
    if (!hasActiveSessionConflict && session.status === PaymentStatus.INITIATED && targetAccountId) {
      queueResult = await ctx.queueEngine.enqueueOrActivate(session.id, targetAccountId);
      if (queueResult.expiresAt) {
        await ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse(session.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise ? session.amountPaise.toString() : '0'
      });
    }

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'CUSTOMER_AUTHENTICATED_AND_BOUND',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { email: customer.email, mobileNumber: customer.mobileNumber, sessionStatus: queueResult.status, hasActiveSessionConflict }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      expiresAt: queueResult.expiresAt,
      hasActiveSessionConflict,
      conflictingSession,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        fullName: customer.name,
        phoneNumber: customer.mobileNumber
      }
    });
  });

  server.post('/api/v1/checkout/:id/retry-new-payment', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 409, {
        error: 'SESSION_PROCESSING',
        message: 'Cannot retry payment while session is in PROCESSING status.'
      });
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot retry payment for terminal session in status '${session.status}'` });
      return;
    }

    const customerId = session.customerId;
    const requestingDeviceId = req.headers['x-device-id'] || session.deviceId || null;

    const processingConflict = await ctx.db.query(`
      SELECT id FROM payment_sessions
      WHERE id != ? AND status = 'PROCESSING'
        AND (
          (CAST(? AS TEXT) IS NOT NULL AND customer_id = ?)
          OR (CAST(? AS TEXT) IS NOT NULL AND device_id = ?)
        )
    `, [session.id, customerId, customerId, requestingDeviceId, requestingDeviceId]);
    if (processingConflict.length > 0) {
      HttpServer.json(res, 409, {
        error: 'SESSION_PROCESSING',
        message: 'Another payment session for this customer or device is currently in bank verification (PROCESSING) and cannot be cancelled.'
      });
      return;
    }

    const conflicting = await ctx.db.query(`
      SELECT id, receiving_account_id, status FROM payment_sessions
      WHERE id != ? AND status IN ('ACTIVE', 'QUEUED')
        AND (
          (CAST(? AS TEXT) IS NOT NULL AND customer_id = ?)
          OR (CAST(? AS TEXT) IS NOT NULL AND device_id = ?)
        )
    `, [session.id, customerId, customerId, requestingDeviceId, requestingDeviceId]);

    for (const c of conflicting) {
      await ctx.sessionRepo.transitionToTerminal(c.id, PaymentStatus.CANCELLED, {
        reason: 'USER_RETRY_NEW_PAYMENT',
        replacedBySessionId: session.id
      });
      if (ctx.timingEngine) {
        await ctx.timingEngine.cancelActiveTimer(c.id);
        if (typeof ctx.timingEngine.clearTimers === 'function') {
          await ctx.timingEngine.clearTimers(c.id);
        }
      }
      server.broadcastSse(c.id, 'status_change', {
        status: PaymentStatus.CANCELLED,
        reason: 'USER_RETRY_NEW_PAYMENT'
      });
    }

    const activeMerchantAcc = ctx.accountRepo ? await ctx.accountRepo.findActiveForMerchant(session.merchantId) : null;
    const targetAccountId = activeMerchantAcc?.id ||
      session.receivingAccountId ||
      session.metadata?.receivingAccountSnapshot?.id;

    if (targetAccountId && session.receivingAccountId !== targetAccountId) {
      await ctx.db.execute('UPDATE payment_sessions SET receiving_account_id = ? WHERE id = ?', [targetAccountId, session.id]);
      session.receivingAccountId = targetAccountId;
    }

    let queueResult = { status: session.status, queuePosition: session.queuePosition, expiresAt: session.expiresAt };
    if (targetAccountId) {
      queueResult = await ctx.queueEngine.enqueueOrActivate(session.id, targetAccountId);
      if (queueResult.expiresAt) {
        await ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse(session.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise ? session.amountPaise.toString() : '0'
      });
      await ctx.sessionRepo.reindexQueue(targetAccountId);
    }

    const updated = await ctx.sessionRepo.findById(session.id);
    HttpServer.json(res, 200, {
      success: true,
      paymentId: updated.id,
      status: updated.status,
      queuePosition: updated.queuePosition || 0,
      expiresAt: updated.expiresAt,
      message: 'Previous active session cancelled. New payment session activated.'
    });
  });

  server.post('/api/v1/checkout/:id/payment-done', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 200, {
        status: PaymentStatus.PROCESSING,
        message: 'Already in verification processing.'
      });
      return;
    }

    const now = Date.now();
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt && session.expiresAt.getTime() <= now) {
      await ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED);
      if (session.receivingAccountId) {
        await ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
      HttpServer.json(res, 400, {
        error: 'Cannot start verification: payment session has EXPIRED.'
      });
      return;
    }

    if (session.status !== PaymentStatus.ACTIVE) {
      HttpServer.json(res, 400, {
        error: `Cannot start verification: session is in status '${session.status}', must be 'ACTIVE'.`
      });
      return;
    }

    const updated = await ctx.timingEngine.handlePaymentDone(params.id);

    server.broadcastSse(params.id, 'status_change', {
      status: PaymentStatus.PROCESSING,
      processingExpiresAt: updated.processingExpiresAt
    });
    server.broadcastSse('admin_counter_events', 'status_change', {
      status: PaymentStatus.PROCESSING,
      sessionId: updated.id,
      orderId: updated.orderId,
      amountPaise: updated.amountPaise ? updated.amountPaise.toString() : '0'
    });

    HttpServer.json(res, 200, {
      paymentId: updated.id,
      status: PaymentStatus.PROCESSING,
      processingExpiresAt: updated.processingExpiresAt
    });
  });

  server.post('/api/v1/checkout/:id/cancel', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      HttpServer.json(res, 200, {
        paymentId: session.id,
        status: session.status
      });
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 409, {
        error: 'SESSION_PROCESSING',
        message: 'Cannot cancel a payment session while bank verification is in progress (PROCESSING).'
      });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    const updated = await ctx.timingEngine.handleCancel(params.id);

    server.broadcastSse(params.id, 'status_change', {
      status: PaymentStatus.CANCELLED
    });

    HttpServer.json(res, 200, {
      paymentId: updated?.id || session.id,
      status: PaymentStatus.CANCELLED
    });
  });

  server.post('/api/v1/checkout/:id/select-method', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const { method } = body;

    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 400, { error: `Cannot switch payment method while payment is in PROCESSING status: Cannot switch payment method for session in status 'PROCESSING'` });
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot switch payment method for session in status '${session.status}'` });
      return;
    }

    const validMethods = [PaymentMethod.UPI, PaymentMethod.COD, PaymentMethod.CASH_COUNTER, PaymentMethod.CARD_COUNTER];
    if (!validMethods.includes(method)) {
      HttpServer.json(res, 400, { error: `Invalid payment method '${method}'. Allowed: ${validMethods.join(', ')}` });
      return;
    }

    const merchant = await ctx.merchantRepo.findById(session.merchantId);
    const merchantBranding = merchant?.branding || {};
    const isCounterRequested = method === PaymentMethod.CASH_COUNTER || method === PaymentMethod.CARD_COUNTER;
    let sellingMode = merchantBranding.sellingMode || (isCounterRequested ? 'OFFLINE' : 'ONLINE');
    let rawEnabled = merchantBranding.enabledPaymentMethods || (sellingMode === 'ONLINE' ? ['UPI', 'COD'] : ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']);
    let enabledMethods = ['UPI'];
    if (sellingMode === 'ONLINE') {
      if (rawEnabled.includes('COD')) enabledMethods.push('COD');
    } else {
      if (rawEnabled.includes('CASH_COUNTER')) enabledMethods.push('CASH_COUNTER');
      if (rawEnabled.includes('CARD_COUNTER')) enabledMethods.push('CARD_COUNTER');
    }

    if (!enabledMethods.includes(method)) {
      HttpServer.json(res, 400, { error: `Payment method '${method}' is disabled by the merchant.` });
      return;
    }

    const previousMethod = session.method;
    const isCounter = method === PaymentMethod.CASH_COUNTER || method === PaymentMethod.CARD_COUNTER;
    const isCod = method === PaymentMethod.COD;
    const wasCounter = previousMethod === PaymentMethod.CASH_COUNTER || previousMethod === PaymentMethod.CARD_COUNTER;
    const wasCod = previousMethod === PaymentMethod.COD;
    const wasUpi = previousMethod === PaymentMethod.UPI || (!wasCounter && !wasCod);
    const nowIso = new Date().toISOString();

    let updates = `method = ?, updated_at = ?`;
    let updateParams = [method, nowIso];

    let oldReceivingAccountId = null;
    let timeRemainingSeconds = 0;
    let newExpiresAt = null;

    if (isCounter || isCod) {
      if (session.receivingAccountId) {
        oldReceivingAccountId = session.receivingAccountId;
      }

      if (ctx.timingEngine) {
        await ctx.timingEngine.cancelActiveTimer(session.id);
      }

      if (isCod) {
        newExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
        updates += `, receiving_account_id = NULL, status = 'ACTIVE', queue_position = 0, expires_at = ?`;
        updateParams.push(newExpiresAt.toISOString());
        session.receivingAccountId = null;
        session.status = PaymentStatus.ACTIVE;
        session.queuePosition = 0;
        session.expiresAt = newExpiresAt;

        if (ctx.timingEngine) {
          await ctx.timingEngine.startActiveTimer(session.id, newExpiresAt);
        }
        timeRemainingSeconds = 300;
      } else {
        updates += `, receiving_account_id = NULL, status = 'ACTIVE', queue_position = 0, expires_at = NULL`;
        session.receivingAccountId = null;
        session.status = PaymentStatus.ACTIVE;
        session.queuePosition = 0;
        session.expiresAt = null;
        timeRemainingSeconds = 0;
      }
    } else if (!isCounter && !isCod && (wasCounter || wasCod)) {
      if (ctx.timingEngine) {
        await ctx.timingEngine.cancelActiveTimer(session.id);
      }

      const receivingAccount = await ctx.accountRepo.findActiveForMerchant(session.merchantId);
      if (receivingAccount) {
        const queueResult = await ctx.queueEngine.enqueueOrActivate(session.id, receivingAccount.id);
        updates += `, receiving_account_id = ?, status = ?, queue_position = ?, expires_at = ?`;
        updateParams.push(
          receivingAccount.id,
          queueResult.status,
          queueResult.queuePosition,
          queueResult.expiresAt ? queueResult.expiresAt.toISOString() : null
        );
        session.receivingAccountId = receivingAccount.id;
        session.status = queueResult.status;
        session.queuePosition = queueResult.queuePosition;
        session.expiresAt = queueResult.expiresAt;

        if (queueResult.expiresAt && ctx.timingEngine && queueResult.status === PaymentStatus.ACTIVE) {
          await ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
        }
        if (queueResult.expiresAt) {
          timeRemainingSeconds = Math.max(0, Math.ceil((queueResult.expiresAt.getTime() - Date.now()) / 1000));
        }
      }
    } else if (!isCounter && !isCod && session.expiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000));
    }

    updateParams.push(session.id);
    await ctx.db.execute(`UPDATE payment_sessions SET ${updates} WHERE id = ?`, updateParams);
    session.method = method;

    if (oldReceivingAccountId) {
      await ctx.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_slot_busy = false, current_active_session_id = NULL, updated_at = ?
        WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
      `, [nowIso, oldReceivingAccountId, session.id]);

      const promoted = await ctx.queueEngine.promoteNext(oldReceivingAccountId);
      if (promoted) {
        if (promoted.expiresAt && ctx.timingEngine) {
          await ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
        }
        server.broadcastSse(promoted.id, 'status_change', {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: promoted.expiresAt
        });
        server.broadcastSse(`queue_${oldReceivingAccountId}`, 'queue_update', {
          promotedId: promoted.id
        });
      } else {
        await ctx.sessionRepo.reindexQueue(oldReceivingAccountId);
      }
    }

    server.broadcastSse(session.id, 'status_change', {
      status: session.status,
      method: session.method,
      queuePosition: session.queuePosition || 0,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null
    });

    if (isCounter) {
      server.broadcastSse('admin_counter_events', 'counter_payment_requested', {
        paymentId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise.toString(),
        method: session.method,
        status: session.status,
        createdAt: session.createdAt
      });
    }

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'PAYMENT_METHOD_SWITCHED',
        actorType: 'CUSTOMER',
        details: { from: previousMethod, to: method }
      });
    }

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.METHOD_SWITCHED', {
        paymentId: session.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        fromMethod: previousMethod,
        toMethod: method
      });
    }

    const counterInstr = method === PaymentMethod.CARD_COUNTER
      ? (merchantBranding.cardCounterInstructions || merchantBranding.counterInstructions || 'Please visit the billing counter and pay via Card POS.')
      : (merchantBranding.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.');

    HttpServer.json(res, 200, {
      success: true,
      paymentId: session.id,
      method: session.method,
      status: session.status,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      counterInstructions: counterInstr
    });
  });

  server.post('/api/v1/checkout/:id/confirm-cod', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 400, { error: 'Cannot place COD order while payment is in PROCESSING status' });
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot place COD order for terminal session in status '${session.status}'` });
      return;
    }

    if (!isValidTransition(session.status, PaymentStatus.SUCCESS)) {
      HttpServer.json(res, 409, { error: `Cannot place COD order for session in status '${session.status}'.` });
      return;
    }

    const merchant = await ctx.merchantRepo.findById(session.merchantId);
    const branding = merchant?.branding || {};
    const sellingMode = branding.sellingMode || (branding.enabledPaymentMethods?.some(m => m === 'CASH_COUNTER' || m === 'CARD_COUNTER') ? 'OFFLINE' : 'ONLINE');
    if (sellingMode !== 'ONLINE') {
      HttpServer.json(res, 400, { error: 'Cash on Delivery is only available in Online Selling Mode.' });
      return;
    }

    const rawEnabled = branding.enabledPaymentMethods || ['UPI'];
    if (!rawEnabled.includes('COD')) {
      HttpServer.json(res, 400, { error: 'Cash on Delivery is currently disabled by merchant.' });
      return;
    }

    if (ctx.timingEngine) {
      if (typeof ctx.timingEngine.cancelActiveTimer === 'function') {
        await ctx.timingEngine.cancelActiveTimer(session.id);
      }
    }

    const nowIso = new Date().toISOString();
    const oldReceivingAccountId = session.receivingAccountId || session.receiving_account_id;

    await ctx.sessionRepo.db.transaction(async () => {
      await ctx.sessionRepo.db.execute(`
        UPDATE payment_sessions
        SET method = 'COD',
            status = 'SUCCESS',
            verification_tag = 'COD_ORDER_PLACED',
            verification_level = 1,
            completed_at = ?,
            receiving_account_id = NULL,
            updated_at = ?
        WHERE id = ? AND status IN ('INITIATED', 'QUEUED', 'ACTIVE')
      `, [nowIso, nowIso, session.id]);

      if (oldReceivingAccountId) {
        await ctx.sessionRepo.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = false, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
        `, [nowIso, oldReceivingAccountId, session.id]);
      }
    });

    if (oldReceivingAccountId && ctx.queueEngine) {
      const promoted = await ctx.queueEngine.promoteNext(oldReceivingAccountId);
      if (promoted) {
        if (promoted.expiresAt && ctx.timingEngine) {
          await ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
        }
        server.broadcastSse(promoted.id, 'status_change', {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: promoted.expiresAt
        });
        server.broadcastSse(`queue_${oldReceivingAccountId}`, 'queue_update', {
          promotedId: promoted.id
        });
      }
    }

    const updated = await ctx.sessionRepo.findById(session.id);

    let customer = null;
    if (updated.customerId && ctx.customerRepo) {
      const c = await ctx.customerRepo.findById(updated.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber
        };
      }
    }

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        merchantId: updated.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: updated.id,
        action: 'COD_ORDER_PLACED',
        actorType: 'CUSTOMER',
        details: { orderId: updated.orderId, amountPaise: updated.amountPaise.toString() }
      });
    }

    server.broadcastSse(params.id, 'status_change', {
      status: 'SUCCESS',
      method: 'COD',
      verificationTag: 'COD_ORDER_PLACED'
    });

    if (ctx.webhookEngine && merchant && merchant.webhookUrl) {
      ctx.webhookEngine.dispatch('SUCCESS', updated).catch(err => console.error('COD Webhook dispatch failed:', err.message));
    }

    HttpServer.json(res, 200, {
      success: true,
      paymentId: updated.id,
      orderId: updated.orderId,
      amount: toRupeesString(updated.amountPaise),
      amountPaise: updated.amountPaise.toString(),
      currency: updated.currency,
      method: 'COD',
      status: 'SUCCESS',
      verificationTag: 'COD_ORDER_PLACED',
      customer,
      returnUrl: session.returnUrl
    });
  });

  server.get('/api/v1/checkout/:id/cod', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }
    let customer = null;
    if (await isPaymentOwner(req, session, ctx) && session.customerId && ctx.customerRepo) {
      const c = await ctx.customerRepo.findById(session.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber
        };
      }
    }
    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      method: session.method,
      status: session.status,
      verificationTag: session.verificationTag,
      customer,
      placedAt: session.completedAt || session.createdAt
    });
  });

  server.post('/api/v1/checkout/:id/expire', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.ACTIVE && session.expiresAt && session.expiresAt.getTime() > Date.now()) {
      HttpServer.json(res, 409, {
        error: 'Payment window has not elapsed yet.',
        code: 'NOT_EXPIRED',
        paymentId: session.id,
        status: session.status
      });
      return;
    }

    if (session.status === PaymentStatus.ACTIVE) {
      await ctx.timingEngine.handleActiveTimerExpiration(session.id);
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
    }

    HttpServer.json(res, 200, {
      success: true,
      paymentId: session.id,
      status: PaymentStatus.EXPIRED
    });
  });

  server.post('/api/v1/checkout/:id/trigger-hook', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const action = typeof body.action === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(body.action) ? body.action : undefined;
    let details = body.details;
    if (details !== undefined && details !== null) {
      let serialized = null;
      try { serialized = JSON.stringify(details); } catch { }
      details = (serialized && serialized.length <= 2048 && typeof details === 'object' && !Array.isArray(details)) ? details : { note: 'details dropped: must be an object under 2KB' };
    }

    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = await checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    const token = body.token ||
      body.sessionToken ||
      req.headers['x-customer-token'] ||
      ((req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
    const authContext = (token && typeof token === 'string' && ctx.customerSessionRepo)
      ? await ctx.customerSessionRepo.findByToken(token.trim())
      : null;

    const hasValidCustomerToken = Boolean(
      authContext?.customer && (!session.customerId || authContext.customer.id === session.customerId)
    );
    const hasVerifiedDevice = Boolean(deviceAccess.boundDeviceId);
    const hasOwnerAuth = await isPaymentOwner(req, session, ctx);

    if (!hasValidCustomerToken && !hasVerifiedDevice && !hasOwnerAuth) {
      HttpServer.json(res, 401, {
        error: 'A valid customer session token or bound device credential is required to trigger checkout hooks.',
        code: 'CUSTOMER_SESSION_REQUIRED'
      });
      return;
    }

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: `HOOK_${action || 'USER_ACTION'}`,
        actorType: 'CUSTOMER',
        details: details || {}
      });
    }

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.ACTION_TRIGGERED', {
        paymentId: session.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        action: action || 'ACTION',
        details: details || {}
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      action: action || 'ACTION',
      timestamp: new Date().toISOString()
    });
  });

  server.post('/api/v1/checkout/:id/simulate-observation', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }

    const body = await HttpServer.parseBody(req);
    const source = (body.source || 'SMS').toUpperCase();
    const rawText = (body.rawText || body.message || body.text || '').toString();
    const sender = (body.sender || '').toString();

    if (!rawText) {
      HttpServer.json(res, 400, { error: 'Missing message body' });
      return;
    }

    const pipeline = ctx.pipeline;
    if (!pipeline) {
      HttpServer.json(res, 500, { error: 'Verification pipeline not available' });
      return;
    }

    const result = await pipeline.process({
      source,
      rawText,
      sender,
      paymentSessionId: session.id,
      receivingAccountId: session.receivingAccountId,
      isTest: Boolean(body.isTest),
      testModeActive: Boolean(body.testModeActive)
    });

    if (result.status === 'REJECTED' && result.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        error: 'FRAUDULENT_PAYMENT_INJECTION: Fake payment observation detected. User banned and session terminated.'
      });
      return;
    }

    HttpServer.json(res, 200, {
      success: result.success,
      status: result.status,
      result
    });
  });

  async function handleEndAndRestartPayment(req, res, params) {
    const session = await ctx.sessionRepo.findById(params.id);
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const conflictingSessionId = body?.conflictingSessionId || body?.conflicting_session_id || null;

    if (!session && !conflictingSessionId) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const targetSession = session || await ctx.sessionRepo.findById(conflictingSessionId);
    if (!targetSession) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const newDeviceId = req.headers['x-device-id'] || body?.deviceId || null;
    if (!newDeviceId) {
      HttpServer.json(res, 400, { error: 'Current device identity is required to bind the new payment session.' });
      return;
    }

    const sourceSession = (conflictingSessionId ? await ctx.sessionRepo.findById(conflictingSessionId) : null) || targetSession;

    const paidSession = [sourceSession, targetSession, session].find(s => s && s.status === PaymentStatus.SUCCESS);
    if (paidSession) {
      HttpServer.json(res, 409, {
        error: 'ORDER_ALREADY_PAID',
        message: 'This order has already been paid and cannot be restarted.',
        orderId: paidSession.orderId,
        status: PaymentStatus.SUCCESS
      });
      return;
    }

    const processingSession = [sourceSession, targetSession, session].find(s => s && s.status === PaymentStatus.PROCESSING);
    if (processingSession) {
      HttpServer.json(res, 409, {
        error: 'SESSION_PROCESSING',
        message: 'Cannot terminate or restart a payment session while bank verification is in progress (PROCESSING).',
        sessionId: processingSession.id,
        status: PaymentStatus.PROCESSING
      });
      return;
    }

    const newDeviceToken = req.headers['x-device-token'] || body?.deviceToken || null;
    const newDeviceSignature = req.headers['x-device-signature'] || body?.deviceSignature || null;
    const newSignaturePayload = req.headers['x-device-payload'] || body?.signaturePayload || null;

    const credCheck = await verifyRegisteredDeviceCredentials({
      deviceId: newDeviceId,
      deviceToken: newDeviceToken,
      deviceSignature: newDeviceSignature,
      signaturePayload: newSignaturePayload,
      deviceRepo: ctx.deviceRepo
    });
    if (!credCheck.valid) {
      HttpServer.json(res, 401, {
        error: credCheck.error || 'DEVICE_CREDENTIALS_INVALID',
        message: credCheck.message || 'A registered device and valid device credential are required.'
      });
      return;
    }

    const rawCustToken = body?.token ||
      body?.sessionToken ||
      req.headers['x-customer-token'] ||
      ((req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
    const authCtx = (rawCustToken && ctx.customerSessionRepo)
      ? await ctx.customerSessionRepo.findByToken(String(rawCustToken).trim())
      : null;
    const authenticatedCustomerId = authCtx?.customer?.id || null;

    if (body?.customerId && (!authenticatedCustomerId || body.customerId !== authenticatedCustomerId)) {
      HttpServer.json(res, 401, {
        error: 'CUSTOMER_AUTH_REQUIRED',
        message: 'Customer identity cannot be supplied in the request body without a matching valid customer session token.'
      });
      return;
    }

    if (authenticatedCustomerId && sourceSession?.customerId && sourceSession.customerId !== authenticatedCustomerId) {
      HttpServer.json(res, 403, {
        error: 'CUSTOMER_MISMATCH',
        message: 'Authenticated customer does not match the payment session owner.'
      });
      return;
    }

    const customerId = authenticatedCustomerId || sourceSession?.customerId || targetSession.customerId || null;

    const NON_CANCELLABLE_STATES = [
      PaymentStatus.PROCESSING,
      PaymentStatus.CANCELLED,
      PaymentStatus.EXPIRED,
      PaymentStatus.FAILED,
      PaymentStatus.SUCCESS,
      PaymentStatus.SUSPICIOUS
    ];
    const sessionsToTerminate = new Map();

    if (!NON_CANCELLABLE_STATES.includes(targetSession.status)) {
      sessionsToTerminate.set(targetSession.id, targetSession);
    }

    if (conflictingSessionId) {
      const confSess = await ctx.sessionRepo.findById(conflictingSessionId);
      if (confSess?.status === PaymentStatus.PROCESSING) {
        HttpServer.json(res, 409, {
          error: 'SESSION_PROCESSING',
          message: 'Conflicting payment session is currently in bank verification (PROCESSING) and cannot be terminated.'
        });
        return;
      }
      if (confSess && !NON_CANCELLABLE_STATES.includes(confSess.status)) {
        sessionsToTerminate.set(confSess.id, confSess);
      }
    }

    if (customerId && ctx.sessionRepo.findAllActiveOrPendingForCustomer) {
      const custSessions = await ctx.sessionRepo.findAllActiveOrPendingForCustomer(customerId);
      for (const cs of custSessions) {
        if (cs.status === PaymentStatus.PROCESSING) {
          HttpServer.json(res, 409, {
            error: 'SESSION_PROCESSING',
            message: 'Another payment session for this customer is currently in bank verification (PROCESSING) and cannot be terminated.'
          });
          return;
        }
        if (!NON_CANCELLABLE_STATES.includes(cs.status)) {
          if (!cs.deviceId || cs.deviceId !== newDeviceId || cs.id === targetSession.id) {
            sessionsToTerminate.set(cs.id, cs);
          }
        }
      }
    }

    if (session && session.id !== targetSession.id && !NON_CANCELLABLE_STATES.includes(session.status)) {
      sessionsToTerminate.set(session.id, session);
    }

    const receivingAccountIdForLookup = targetSession.receivingAccountId || session?.receivingAccountId;
    if (receivingAccountIdForLookup && ctx.sessionRepo.findCurrentActiveOrProcessing) {
      const activeOnAcc = await ctx.sessionRepo.findCurrentActiveOrProcessing(receivingAccountIdForLookup);
      if (activeOnAcc && activeOnAcc.deviceId !== newDeviceId) {
        const cleanTargetOrder = targetSession.orderId ? targetSession.orderId.replace(/-R\d+$/, '') : '';
        const cleanActiveOrder = activeOnAcc.orderId ? activeOnAcc.orderId.replace(/-R\d+$/, '') : '';
        if ((cleanTargetOrder && cleanTargetOrder === cleanActiveOrder) || (customerId && activeOnAcc.customerId === customerId)) {
          if (activeOnAcc.status === PaymentStatus.PROCESSING) {
            HttpServer.json(res, 409, {
              error: 'SESSION_PROCESSING',
              message: 'Active payment session for this order is currently in bank verification (PROCESSING) and cannot be terminated.'
            });
            return;
          }
          sessionsToTerminate.set(activeOnAcc.id, activeOnAcc);
        }
      }
    }

    const activeMerchantAcc = ctx.accountRepo ? await ctx.accountRepo.findActiveForMerchant(sourceSession.merchantId) : null;
    const targetReceivingAccountId = activeMerchantAcc?.id || sourceSession.receivingAccountId;

    const affectedAccountIds = new Set();
    for (const [sId, sObj] of sessionsToTerminate.entries()) {
      if (sObj?.receivingAccountId) {
        affectedAccountIds.add(sObj.receivingAccountId);
      }
    }
    if (receivingAccountIdForLookup) {
      affectedAccountIds.add(receivingAccountIdForLookup);
    }
    if (targetReceivingAccountId) {
      affectedAccountIds.add(targetReceivingAccountId);
    }

    for (const [sId, sObj] of sessionsToTerminate.entries()) {
      await ctx.sessionRepo.transitionToTerminal(sId, PaymentStatus.CANCELLED, {
        reason: 'REPLACED_ON_ANOTHER_DEVICE',
        replacedByDeviceId: newDeviceId
      });

      if (ctx.timingEngine) {
        await ctx.timingEngine.cancelActiveTimer(sId);
        if (typeof ctx.timingEngine.clearTimers === 'function') {
          await ctx.timingEngine.clearTimers(sId);
        }
      }

      server.broadcastSse(sId, 'status_change', {
        status: PaymentStatus.CANCELLED,
        reason: 'REPLACED_ON_ANOTHER_DEVICE',
        message: 'Payment session closed because you continued on another device.'
      });
    }

    const termIds = Array.from(sessionsToTerminate.keys());
    for (const accId of affectedAccountIds) {
      const nowIso = new Date().toISOString();
      if (termIds.length > 0) {
        await ctx.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = false, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id IN (${termIds.map(() => '?').join(',')}) OR current_active_session_id IS NULL)
        `, [nowIso, accId, ...termIds]);
      }

      if (ctx.sessionRepo.reindexQueue) {
        await ctx.sessionRepo.reindexQueue(accId);
      }

      if (ctx.queueEngine && typeof ctx.queueEngine.promoteNext === 'function') {
        const promoted = await ctx.queueEngine.promoteNext(accId);
        if (promoted) {
          if (ctx.timingEngine && promoted.expiresAt) {
            await ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
          }
          server.broadcastSse(promoted.id, 'status_change', {
            status: PaymentStatus.ACTIVE,
            queuePosition: 0,
            expiresAt: promoted.expiresAt
          });
          server.broadcastSse('admin_counter_events', 'status_change', {
            status: PaymentStatus.ACTIVE,
            sessionId: promoted.id,
            orderId: promoted.orderId,
            amountPaise: promoted.amountPaise ? promoted.amountPaise.toString() : '0'
          });
        }
      }
    }

    const newOrderId = sourceSession.orderId ? sourceSession.orderId.replace(/-R\d+$/, '') : `ORD-${Date.now()}`;

    if (newDeviceId && ctx.deviceRepo) {
      await ctx.deviceRepo.touch(newDeviceId);
    }

    const newSession = await ctx.sessionRepo.create({
      merchantId: sourceSession.merchantId,
      customerId: customerId || sourceSession.customerId,
      receivingAccountId: targetReceivingAccountId,
      orderId: newOrderId,
      amountPaise: sourceSession.amountPaise,
      currency: sourceSession.currency,
      method: sourceSession.method || PaymentMethod.UPI,
      status: PaymentStatus.INITIATED,
      returnUrl: sourceSession.returnUrl,
      deviceId: newDeviceId,
      metadata: {
        ...(sourceSession.metadata || {}),
        reboundFromSessionId: sourceSession.id,
        reboundAt: new Date().toISOString()
      }
    });

    if (customerId && ctx.deviceRepo) {
      try { await ctx.deviceRepo.associateCustomer(newDeviceId, customerId); } catch {}
    }

    let queueResult = { status: newSession.status, queuePosition: 0, expiresAt: null };
    if (newSession.receivingAccountId && (String(newSession.method).toUpperCase() === 'UPI' || !newSession.method)) {
      queueResult = await ctx.queueEngine.enqueueOrActivate(newSession.id, newSession.receivingAccountId);
      if (queueResult.expiresAt && ctx.timingEngine) {
        await ctx.timingEngine.startActiveTimer(newSession.id, queueResult.expiresAt);
      }
      server.broadcastSse(newSession.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: newSession.id,
        orderId: newSession.orderId,
        amountPaise: newSession.amountPaise ? newSession.amountPaise.toString() : '0'
      });
    }

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        merchantId: sourceSession.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: newSession.id,
        action: 'PAYMENT_SESSION_RECREATED_ON_NEW_DEVICE',
        actorType: 'CUSTOMER',
        actorId: customerId || 'ANONYMOUS',
        details: {
          terminatedSessionIds: Array.from(sessionsToTerminate.keys()),
          newSessionId: newSession.id,
          newDeviceId
        }
      });
    }

    HttpServer.json(res, 201, {
      success: true,
      oldSessionId: targetSession.id,
      terminatedSessionIds: Array.from(sessionsToTerminate.keys()),
      newSessionId: newSession.id,
      paymentId: newSession.id,
      orderId: newSession.orderId,
      checkoutUrl: `/checkout/${newSession.id}`,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      expiresAt: queueResult.expiresAt,
      message: 'Previous sessions terminated. New payment session activated and bound to this device.'
    });
  }

  server.post('/api/v1/checkout/:id/end-and-restart-payment', handleEndAndRestartPayment);
  server.post('/api/v1/checkout/:id/end-session-and-create-new', handleEndAndRestartPayment);

  server.get('/api/v1/checkout/:id/stream', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }
    const deviceAccess = await checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    server.initSse(params.id, res);
  });

  server.get('/api/v1/checkout/:id/events', async (req, res, params) => {
    const session = await ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }
    const deviceAccess = await checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    server.initSse(params.id, res);
  });
}
