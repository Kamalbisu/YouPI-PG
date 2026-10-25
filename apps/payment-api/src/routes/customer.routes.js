import crypto from 'node:crypto';
import { HttpServer } from '../server.js';
import { createRateLimiter, envLimit, getClientIp } from '../rate-limit.js';
import { normalizeEmail, normalizeMobile, isValidEmail, isValidMobile, isValidPassword, safeEqual } from '@youpi/common';

const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '***';
  const user = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}***@${domain || '***'}`;
}

export function registerCustomerRoutes(server, ctx) {
  function extractSessionToken(req) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const cookieHeader = req.headers['cookie'] || '';
    const match = cookieHeader.match(/youpi_session=([^;]+)/);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  function buildSessionCookie(token, maxAgeSeconds = 30 * 24 * 3600) {
    const isProd = process.env.NODE_ENV === 'production';
    return `youpi_session=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`;
  }

  const pendingOtpChallenges = new Map();

  const otpRequestLog = new Map();

  const checkUserMax = envLimit('YOUPI_RATE_LIMIT_CHECK_USER_PER_MIN', 60);
  const checkUserLimiter = createRateLimiter({ windowMs: 60 * 1000, max: checkUserMax });
  const otpPerMobileMax = envLimit('YOUPI_RATE_LIMIT_OTP_PER_MOBILE_PER_HOUR', 5);
  const otpPerMobileLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: otpPerMobileMax });
  const otpPerIpMax = envLimit('YOUPI_RATE_LIMIT_OTP_PER_IP_PER_HOUR', 30);
  const otpPerIpLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: otpPerIpMax });
  const authAttemptMax = envLimit('YOUPI_RATE_LIMIT_AUTH_PER_IP_PER_15MIN', 30);
  const authAttemptLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: authAttemptMax });
  const loginFailureMax = envLimit('YOUPI_RATE_LIMIT_LOGIN_FAILURES_PER_15MIN', 10);
  const loginFailureLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: loginFailureMax });

  function tooManyAuthAttempts(req, res) {
    if (authAttemptMax > 0 && !authAttemptLimiter.allow(getClientIp(req))) {
      res.setHeader('Retry-After', '900');
      HttpServer.json(res, 429, { error: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' });
      return true;
    }
    return false;
  }

  function getOtpCooldownMs() {
    if (ctx && typeof ctx.otpCooldownMs === 'number' && ctx.otpCooldownMs >= 0) {
      return ctx.otpCooldownMs;
    }
    if (process.env.OTP_RESEND_COOLDOWN_MS !== undefined) {
      const val = Number(process.env.OTP_RESEND_COOLDOWN_MS);
      if (Number.isFinite(val) && val >= 0) {
        return val;
      }
    }
    return OTP_RESEND_COOLDOWN_MS;
  }

  function isOtpThrottled(mobile) {
    const cooldownMs = getOtpCooldownMs();
    if (cooldownMs === 0) {
      return false;
    }
    const now = Date.now();
    for (const [key, at] of otpRequestLog) {
      if (now - at > cooldownMs) otpRequestLog.delete(key);
    }
    if (otpRequestLog.has(mobile)) return true;
    otpRequestLog.set(mobile, now);
    return false;
  }

  if (ctx) {
    ctx.resetOtpCooldown = (mobile) => {
      if (mobile) {
        otpRequestLog.delete(normalizeMobile(mobile) || mobile);
      } else {
        otpRequestLog.clear();
      }
    };
  }

  function getBerry() {
    return ctx.whatsappBerryService || null;
  }

  server.post('/api/v1/customer/check-user', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const rawMobile = body.mobileNumber || body.phoneNumber || body.mobile || body.phone;

    if (!rawMobile) {
      HttpServer.json(res, 400, { error: 'Mobile number is required.' });
      return;
    }

    const cleanMobile = normalizeMobile(rawMobile);
    if (!cleanMobile || !isValidMobile(cleanMobile)) {
      HttpServer.json(res, 400, { error: 'Please enter a valid 10-digit mobile number.' });
      return;
    }

    if (checkUserMax > 0 && !checkUserLimiter.allow(getClientIp(req))) {
      res.setHeader('Retry-After', '60');
      HttpServer.json(res, 429, { error: 'Too many requests. Please try again in a minute.' });
      return;
    }

    const existingUser = await ctx.customerRepo.findByMobile(cleanMobile);

    HttpServer.json(res, 200, {
      success: true,
      exists: Boolean(existingUser),
      mobileNumber: cleanMobile,
      customer: existingUser ? {
        name: existingUser.name,
        email: maskEmail(existingUser.email),
        mobileNumber: cleanMobile
      } : null
    });
  });

  server.post('/api/v1/customer/send-otp', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const rawMobile = body.mobileNumber || body.phoneNumber || body.mobile || body.phone;
    const name = (body.name || body.fullName || '').trim();
    const email = normalizeEmail(body.email);
    const isNewUser = Boolean(body.isNewUser);

    if (!rawMobile) {
      HttpServer.json(res, 400, { error: 'Mobile number is required.' });
      return;
    }

    const cleanMobile = normalizeMobile(rawMobile);
    if (!cleanMobile || !isValidMobile(cleanMobile)) {
      HttpServer.json(res, 400, { error: 'Please enter a valid 10-digit mobile number.' });
      return;
    }

    const existingUser = await ctx.customerRepo.findByMobile(cleanMobile);

    if (isOtpThrottled(cleanMobile)) {
      HttpServer.json(res, 429, { error: `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000)} seconds before requesting another code.` });
      return;
    }

    if ((otpPerMobileMax > 0 && !otpPerMobileLimiter.allow(cleanMobile)) ||
        (otpPerIpMax > 0 && !otpPerIpLimiter.allow(getClientIp(req)))) {
      res.setHeader('Retry-After', '3600');
      HttpServer.json(res, 429, { error: 'Too many verification codes requested. Please try again later.', code: 'RATE_LIMITED' });
      return;
    }

    if (!existingUser && isNewUser) {
      if (!name) {
        HttpServer.json(res, 400, { error: 'Full name is required for registration.' });
        return;
      }
      if (!email || !isValidEmail(email)) {
        HttpServer.json(res, 400, { error: 'A valid email address is required for registration.' });
        return;
      }
      const existingByEmail = await ctx.customerRepo.findByEmail(email);
      if (existingByEmail) {
        HttpServer.json(res, 409, { error: 'An account with this email address already exists. Please log in.' });
        return;
      }
    }

    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    if (existingUser) {
      await ctx.customerRepo.setOtp(cleanMobile, otpCode, expiresAt);
    } else {
      const previous = pendingOtpChallenges.get(cleanMobile);
      const previousLive = previous && new Date(previous.expiresAt) > new Date();
      pendingOtpChallenges.set(cleanMobile, {
        otpCode,
        expiresAt,
        attempts: previousLive ? (previous.attempts || 0) : 0,
        name: name || `Customer ${cleanMobile.slice(-4)}`,
        email: email || `${cleanMobile}@customer.youpi.local`
      });
    }

    const berry = getBerry();
    let dispatchResult = { success: true, delivered: false, simulated: true };
    const displayName = existingUser?.name || name || '';

    if (berry) {
      try {
        dispatchResult = await berry.sendOtp(cleanMobile, otpCode, displayName);
      } catch (err) {
        console.warn(`[CustomerAuth] WhatsApp dispatch notice: ${err.message}`);
      }
    } else {
      console.log(`[CustomerAuth] Berry service not loaded; OTP for ${cleanMobile} was not delivered.`);
    }

    console.log(`[CustomerAuth] OTP generated for +91${cleanMobile} (expires in 5 mins)`);

    HttpServer.json(res, 200, {
      success: true,
      message: 'OTP sent to your WhatsApp number.',
      mobileNumber: cleanMobile,
      expiresInSeconds: 300,
      devOtp: (process.env.YOUPI_EXPOSE_DEV_OTP === 'true' && process.env.NODE_ENV !== 'production' ? otpCode : undefined),
      dispatch: dispatchResult
    });
  });

  server.post('/api/v1/customer/verify-otp', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const rawMobile = body.mobileNumber || body.phoneNumber || body.mobile || body.phone;
    const otp = String(body.otp || body.code || '').trim();

    if (tooManyAuthAttempts(req, res)) return;
    if (!rawMobile || !otp) {
      HttpServer.json(res, 400, { error: 'Mobile number and 6-digit OTP code are required.' });
      return;
    }

    const cleanMobile = normalizeMobile(rawMobile);
    if (!cleanMobile) {
      HttpServer.json(res, 400, { error: 'Invalid mobile number.' });
      return;
    }

    let customer = await ctx.customerRepo.findByMobile(cleanMobile);

    if (customer) {
      const verified = await ctx.customerRepo.verifyOtp(cleanMobile, otp);
      if (!verified) {
        HttpServer.json(res, 400, { error: 'Invalid or expired verification code. Please request a new OTP.' });
        return;
      }
      customer = verified;
    } else {
      const pending = pendingOtpChallenges.get(cleanMobile);
      if (!pending) {
        HttpServer.json(res, 400, { error: 'No active OTP request found. Please request a new OTP.' });
        return;
      }
      if ((pending.attempts || 0) >= OTP_MAX_ATTEMPTS) {
        pendingOtpChallenges.delete(cleanMobile);
        HttpServer.json(res, 429, { error: 'Too many incorrect attempts. Please request a new OTP.' });
        return;
      }
      if (!safeEqual(pending.otpCode, otp)) {
        pending.attempts = (pending.attempts || 0) + 1;
        HttpServer.json(res, 400, { error: 'Invalid verification code. Please check and try again.' });
        return;
      }
      if (new Date() > new Date(pending.expiresAt)) {
        pendingOtpChallenges.delete(cleanMobile);
        HttpServer.json(res, 400, { error: 'Verification code has expired. Please request a new OTP.' });
        return;
      }

      const resolvedName = (body.name || body.fullName || pending.name || `Customer ${cleanMobile.slice(-4)}`).trim();
      const resolvedEmail = normalizeEmail(body.email || pending.email) || `${cleanMobile}@customer.youpi.local`;

      try {
        customer = await ctx.customerRepo.create({
          name: resolvedName,
          email: resolvedEmail,
          mobileNumber: cleanMobile,
          isPhoneVerified: true
        });
      } catch (err) {
        HttpServer.json(res, 400, { error: err.message });
        return;
      }

      pendingOtpChallenges.delete(cleanMobile);
    }

    if (customer.status === 'BANNED') {
      HttpServer.json(res, 403, {
        error: 'ACCESS BLOCKED',
        message: 'Your account has been temporarily blocked because suspicious payment activity was detected. Our team will review the activity before access can be restored.',
        isBanned: true
      });
      return;
    }

    const ipAddress = getClientIp(req) || null;
    const userAgent = req.headers['user-agent'] || null;
    const session = await ctx.customerSessionRepo.create({
      customerId: customer.id,
      ipAddress,
      userAgent
    });

    res.setHeader('Set-Cookie', buildSessionCookie(session.token));

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        entityType: 'CUSTOMER',
        entityId: customer.id,
        action: 'CUSTOMER_WHATSAPP_OTP_LOGGED_IN',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { mobileNumber: customer.mobileNumber, email: customer.email }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      token: session.token,
      customerId: customer.id,
      phoneNumber: customer.mobileNumber,
      fullName: customer.name,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        status: customer.status,
        lastLoginAt: customer.lastLoginAt
      }
    });
  });

  server.post('/api/v1/customer/register', async (req, res) => {
    if (tooManyAuthAttempts(req, res)) return;
    const body = await HttpServer.parseBody(req);
    const { name, email, mobileNumber, password } = body;

    const resolvedName = (name || body.fullName || '').trim();
    const resolvedMobile = normalizeMobile(mobileNumber || body.phoneNumber);
    let resolvedEmail = normalizeEmail(email);
    if (!resolvedEmail && resolvedMobile) {
      resolvedEmail = `${resolvedMobile}@customer.youpi.local`;
    }
    const resolvedPassword = password;

    if (!resolvedName) {
      HttpServer.json(res, 400, { error: 'Name is required.' });
      return;
    }
    if (!resolvedEmail || !isValidEmail(resolvedEmail)) {
      HttpServer.json(res, 400, { error: 'A valid email address is required.' });
      return;
    }
    if (!resolvedMobile || !isValidMobile(resolvedMobile)) {
      HttpServer.json(res, 400, { error: 'A valid 10-digit mobile number is required.' });
      return;
    }
    if (!isValidPassword(resolvedPassword)) {
      HttpServer.json(res, 400, { error: 'Password must be at least 6 characters long.' });
      return;
    }

    const existingByEmail = await ctx.customerRepo.findByEmail(resolvedEmail);
    if (existingByEmail) {
      HttpServer.json(res, 409, { error: 'An account with this email address already exists.' });
      return;
    }

    const existingByMobile = await ctx.customerRepo.findByMobile(resolvedMobile);
    if (existingByMobile) {
      HttpServer.json(res, 409, { error: 'An account with this mobile number already exists.' });
      return;
    }

    let customer;
    try {
      customer = await ctx.customerRepo.create({
        name: resolvedName,
        email: resolvedEmail,
        mobileNumber: resolvedMobile,
        password: resolvedPassword
      });
    } catch (err) {
      HttpServer.json(res, 400, { error: err.message });
      return;
    }

    const ipAddress = getClientIp(req) || null;
    const userAgent = req.headers['user-agent'] || null;
    const session = await ctx.customerSessionRepo.create({
      customerId: customer.id,
      ipAddress,
      userAgent
    });

    res.setHeader('Set-Cookie', buildSessionCookie(session.token));

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        entityType: 'CUSTOMER',
        entityId: customer.id,
        action: 'CUSTOMER_REGISTERED',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { email: customer.email, mobileNumber: customer.mobileNumber }
      });
    }

    HttpServer.json(res, 201, {
      success: true,
      token: session.token,
      customerId: customer.id,
      phoneNumber: customer.mobileNumber,
      fullName: customer.name,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        status: customer.status,
        createdAt: customer.createdAt
      }
    });
  });

  server.post('/api/v1/customer/login', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const identifier = (body.identifier || body.email || body.mobileNumber || body.phoneNumber || '').trim();
    const password = body.password;

    if (tooManyAuthAttempts(req, res)) return;
    if (!identifier || !password) {
      HttpServer.json(res, 400, { error: 'Email/mobile number and password are required.' });
      return;
    }

    const lockKey = identifier.toLowerCase();
    if (loginFailureMax > 0 && loginFailureLimiter.isLimited(lockKey)) {
      res.setHeader('Retry-After', '900');
      HttpServer.json(res, 429, { error: 'Too many failed sign-in attempts. Please try again later.', code: 'RATE_LIMITED' });
      return;
    }

    const verified = await ctx.customerRepo.verifyCredentials(identifier, password);
    if (!verified) {
      if (loginFailureMax > 0) loginFailureLimiter.allow(lockKey);
      HttpServer.json(res, 401, { error: 'Invalid credentials. Please check your email/mobile and password.' });
      return;
    }

    if (verified.status === 'BANNED') {
      HttpServer.json(res, 403, {
        error: 'ACCESS BLOCKED',
        message: 'Your account has been temporarily blocked because suspicious payment activity was detected. Our team will review the activity before access can be restored.',
        isBanned: true
      });
      return;
    }

    loginFailureLimiter.clear(lockKey);

    const ipAddress = getClientIp(req) || null;
    const userAgent = req.headers['user-agent'] || null;
    const session = await ctx.customerSessionRepo.create({
      customerId: verified.id,
      ipAddress,
      userAgent
    });

    res.setHeader('Set-Cookie', buildSessionCookie(session.token));

    if (ctx.auditRepo) {
      await ctx.auditRepo.log({
        entityType: 'CUSTOMER',
        entityId: verified.id,
        action: 'CUSTOMER_LOGGED_IN',
        actorType: 'CUSTOMER',
        actorId: verified.id,
        details: { identifier }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      token: session.token,
      customerId: verified.id,
      phoneNumber: verified.mobileNumber,
      fullName: verified.name,
      customer: {
        id: verified.id,
        name: verified.name,
        email: verified.email,
        mobileNumber: verified.mobileNumber,
        status: verified.status,
        lastLoginAt: verified.lastLoginAt
      }
    });
  });

  server.get('/api/v1/customer/me', async (req, res) => {
    const token = extractSessionToken(req);
    if (!token) {
      HttpServer.json(res, 401, { error: 'No active session token provided.' });
      return;
    }

    const authContext = await ctx.customerSessionRepo.findByToken(token);
    if (!authContext) {
      HttpServer.json(res, 401, { error: 'Session expired or invalid.' });
      return;
    }

    const { customer, session } = authContext;
    HttpServer.json(res, 200, {
      authenticated: true,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        status: customer.status,
        lastLoginAt: customer.lastLoginAt
      },
      session: {
        id: session.id,
        expiresAt: session.expiresAt
      }
    });
  });

  server.post('/api/v1/customer/logout', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const token = extractSessionToken(req) || body.token;

    if (token) {
      await ctx.customerSessionRepo.revokeToken(token);
    }

    res.setHeader('Set-Cookie', buildSessionCookie('', 0));
    HttpServer.json(res, 200, { success: true, message: 'Logged out successfully.' });
  });

  server.post('/api/v1/customer/switch-account', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const targetToken = body.token || body.sessionToken;

    if (!targetToken) {
      HttpServer.json(res, 400, { error: 'Target account session token is required.' });
      return;
    }

    const authContext = await ctx.customerSessionRepo.findByToken(targetToken);
    if (!authContext) {
      HttpServer.json(res, 401, { error: 'Target account session has expired. Please log in again.' });
      return;
    }

    res.setHeader('Set-Cookie', buildSessionCookie(authContext.session.token));

    HttpServer.json(res, 200, {
      success: true,
      token: authContext.session.token,
      customer: {
        id: authContext.customer.id,
        name: authContext.customer.name,
        email: authContext.customer.email,
        mobileNumber: authContext.customer.mobileNumber
      }
    });
  });

  server.get('/api/v1/customer/payments', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.post('/api/v1/customer/tickets', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.get('/api/v1/customer/tickets/:id/messages', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.post('/api/v1/customer/tickets/:id/messages', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.get('/api/v1/customer/tickets/:id/stream', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });
}
