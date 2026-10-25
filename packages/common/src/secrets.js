import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.resolve(__dirname, '../../../data/.secrets');

const cache = new Map();
const warnedPlaceholders = new Set();

const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'android_pairing_enrollment_secret_key_32_chars',
  'super_secret_jwt_key_change_in_production_min_32_chars',
  'merchant_webhook_secret_for_wallet_store'
]);

export function isPlaceholderSecret(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return false;
  if (KNOWN_PLACEHOLDER_SECRETS.has(v)) return true;
  return /^(replace[_-]?with|changeme|change[_-]me|your[_-]|<.*>$)/.test(v);
}

export function resolveSecret(name, envVar) {
  let fromEnv = envVar ? (process.env[envVar] || '').trim() : '';
  if (fromEnv && isPlaceholderSecret(fromEnv)) {
    if (!warnedPlaceholders.has(envVar)) {
      warnedPlaceholders.add(envVar);
      console.warn(`[secrets] ${envVar} is set to a placeholder/default value and was ignored; using a generated secret instead. Set a real random value to silence this warning.`);
    }
    fromEnv = '';
  }
  if (fromEnv) return fromEnv;
  if (cache.has(name)) return cache.get(name);

  const file = path.join(SECRETS_DIR, name);
  let value = '';
  try { value = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (!value) {
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    const fresh = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(file, fresh, { flag: 'wx', mode: 0o600 });
      value = fresh;
    } catch {
      value = fs.readFileSync(file, 'utf8').trim();
    }
  }
  cache.set(name, value);
  return value;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export const getAdminToken = () => resolveSecret('admin_api_token', 'ADMIN_API_TOKEN');
export const getObserverToken = () => resolveSecret('observer_api_token', 'OBSERVER_API_TOKEN');
export const getCoinStoreWebhookSecret = () => resolveSecret('coin_store_webhook_secret', 'COIN_STORE_WEBHOOK_SECRET');

export const getInternalServiceToken = () => resolveSecret('internal_service_token', 'INTERNAL_SERVICE_TOKEN');

export const getDeviceCredentialKey = () => resolveSecret('device_credential_key', 'DEVICE_CREDENTIAL_KEY');

export const getBlindIndexKey = () => resolveSecret('blind_index_key', 'BLIND_INDEX_KEY');

function isLoopbackRemoteAddress(remoteAddress) {
  if (!remoteAddress || typeof remoteAddress !== 'string') return false;
  const addr = remoteAddress.trim().toLowerCase();
  if (!addr) return false;
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

export function isInternalServiceRequest(req) {
  if (!isLoopbackRemoteAddress(req?.socket?.remoteAddress)) return false;
  const match = /^Bearer\s+(.+)$/i.exec(req?.headers?.['authorization'] || '');
  const presented = (match ? match[1].trim() : '') || (req?.headers?.['x-internal-token'] || '');
  return Boolean(presented) && safeEqual(presented, getInternalServiceToken());
}

export function issueDeviceCredential(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') {
    throw new Error('deviceId is required to issue a device credential');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = String(Date.now());
  const mac = crypto
    .createHmac('sha256', getDeviceCredentialKey())
    .update(`devcred:v1:${deviceId}:${nonce}:${issuedAt}`)
    .digest('hex');
  return `devtok_${deviceId}.${nonce}.${issuedAt}.${mac}`;
}

export function verifyDeviceCredential(deviceId, token) {
  if (!deviceId || typeof deviceId !== 'string' || !token || typeof token !== 'string') {
    return false;
  }
  const prefix = `devtok_${deviceId}.`;
  if (!token.startsWith(prefix)) return false;
  const rest = token.slice(prefix.length);
  const parts = rest.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, presentedMac] = parts;
  if (!nonce || !issuedAt || !presentedMac) return false;
  const expectedMac = crypto
    .createHmac('sha256', getDeviceCredentialKey())
    .update(`devcred:v1:${deviceId}:${nonce}:${issuedAt}`)
    .digest('hex');
  return safeEqual(presentedMac, expectedMac);
}

const DEVICE_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const consumedDeviceChallenges = new Map();

function deviceChallengeMac(deviceId, nonce, expiresAt) {
  return crypto
    .createHmac('sha256', getDeviceCredentialKey())
    .update(`devchal:v1:${deviceId}:${nonce}:${expiresAt}`)
    .digest('hex');
}

export function createDeviceChallenge(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') {
    throw new Error('deviceId is required to create a device challenge');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = String(Date.now() + DEVICE_CHALLENGE_TTL_MS);
  const mac = deviceChallengeMac(deviceId, nonce, expiresAt);
  return `devchal_${deviceId}.${nonce}.${expiresAt}.${mac}`;
}

export function consumeDeviceChallenge(challenge, deviceId) {
  if (typeof challenge !== 'string' || typeof deviceId !== 'string' || !deviceId) return false;
  const prefix = `devchal_${deviceId}.`;
  if (!challenge.startsWith(prefix)) return false;
  const parts = challenge.slice(prefix.length).split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiresAt, mac] = parts;
  if (!nonce || !expiresAt || !mac) return false;
  if (!safeEqual(mac, deviceChallengeMac(deviceId, nonce, expiresAt))) return false;
  const now = Date.now();
  if (!(Number(expiresAt) > now)) return false;
  for (const [k, exp] of consumedDeviceChallenges) {
    if (exp <= now) consumedDeviceChallenges.delete(k);
  }
  const key = `${deviceId}:${nonce}`;
  if (consumedDeviceChallenges.has(key)) return false;
  consumedDeviceChallenges.set(key, Number(expiresAt));
  return true;
}

export const LEGACY_DEFAULT_WEBHOOK_SECRET = 'merchant_webhook_secret_for_wallet_store';

export const getEncryptionMasterKey = () => {
  const key = resolveSecret('encryption_master_key', 'ENCRYPTION_MASTER_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('ENCRYPTION_MASTER_KEY must be exactly 64 hex characters (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return key;
};

const ENC_PREFIX = 'enc:v1:';

export function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export function encryptAtRest(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncryptedValue(plaintext)) return plaintext;
  return ENC_PREFIX + encrypt(String(plaintext), getEncryptionMasterKey());
}

export function decryptAtRest(stored) {
  if (!isEncryptedValue(stored)) return stored;
  try {
    return decrypt(stored.slice(ENC_PREFIX.length), getEncryptionMasterKey());
  } catch {
    return null;
  }
}

export function blindIndex(value, namespace = 'token') {
  if (value === null || value === undefined || value === '') return null;
  const digest = crypto.createHmac('sha256', getBlindIndexKey())
    .update(`${namespace}:${value}`)
    .digest('hex');
  return `${namespace}_v1_${digest}`;
}

export function blindIndexMatches(value, storedIndex, namespace = 'token') {
  if (!value || !storedIndex) return false;
  const candidate = blindIndex(value, namespace);
  if (candidate && safeEqual(candidate, storedIndex)) return true;
  const legacy = crypto.createHmac('sha256', getInternalServiceToken())
    .update(`${namespace}:${value}`)
    .digest('hex');
  return safeEqual(`${namespace}_v1_${legacy}`, storedIndex);
}

export function hasBearer(req, ...tokens) {
  const match = /^Bearer\s+(.+)$/i.exec(req?.headers?.['authorization'] || '');
  if (!match) return false;
  const presented = match[1].trim();
  return tokens.some(t => safeEqual(presented, t));
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

function hexPairToIPv4(hi, lo) {
  const h = parseInt(hi, 16);
  const l = parseInt(lo, 16);
  return `${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`;
}

function embeddedIPv4(lower) {
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const mapped = lower.match(/^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) return hexPairToIPv4(mapped[1], mapped[2]);
  const nat64 = lower.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64) return hexPairToIPv4(nat64[1], nat64[2]);
  return null;
}

function isPrivateAddress(hostname) {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::' || lower === '0.0.0.0') return true;

  const embedded = embeddedIPv4(lower);
  if (embedded) return isPrivateAddress(embedded);
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
  if (sixToFour) return isPrivateAddress(hexPairToIPv4(sixToFour[1], sixToFour[2]));
  if (lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.localhost')) return true;

  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) {
    return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function privateWebhooksAllowed() {
  return process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS === 'true';
}

export function validateOutboundWebhookUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { valid: false, error: 'Webhook URL is required.' };
  if (raw.length > 2048) return { valid: false, error: 'Webhook URL is too long.' };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, error: 'Webhook URL must be a valid absolute URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { valid: false, error: 'Webhook URL must use http:// or https://' };
  }
  if (url.username || url.password) {
    return { valid: false, error: 'Webhook URL must not embed credentials.' };
  }
  const hostname = (url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) return { valid: false, error: 'Webhook URL must include a hostname.' };
  if (!privateWebhooksAllowed() && (BLOCKED_HOSTNAMES.has(hostname) || isPrivateAddress(hostname))) {
    return {
      valid: false,
      error: 'Webhook URL must not point to a loopback or private network address (set YOUPI_ALLOW_PRIVATE_WEBHOOKS=true for self-hosted LAN targets).'
    };
  }
  return { valid: true, url };
}

export async function assertWebhookHostResolvesPublic(url, options = {}) {
  if (privateWebhooksAllowed()) return { valid: true };
  const hostname = (url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return { valid: true };
  const lookup = options.lookup || dns.promises.lookup.bind(dns.promises);
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    const list = Array.isArray(records) ? records : [records];
    if (list.some(r => isPrivateAddress(String(r.address || '')))) {
      return { valid: false, error: 'Webhook hostname resolves to a loopback or private network address.' };
    }
  } catch {
  }
  return { valid: true };
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const consumedOAuthStates = new Map();

function oauthStateMac(payload) {
  return crypto.createHmac('sha256', getObserverToken()).update(`oauth-state:${payload}`).digest('hex');
}

export function createOAuthState() {
  const payload = `${crypto.randomBytes(16).toString('hex')}.${Date.now() + OAUTH_STATE_TTL_MS}`;
  return `${payload}.${oauthStateMac(payload)}`;
}

export function consumeOAuthState(state) {
  if (typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiresAt, mac] = parts;
  if (!safeEqual(mac, oauthStateMac(`${nonce}.${expiresAt}`))) return false;
  const now = Date.now();
  if (!(Number(expiresAt) > now)) return false;
  for (const [key, exp] of consumedOAuthStates) if (exp <= now) consumedOAuthStates.delete(key);
  if (consumedOAuthStates.has(nonce)) return false;
  consumedOAuthStates.set(nonce, Number(expiresAt));
  return true;
}
