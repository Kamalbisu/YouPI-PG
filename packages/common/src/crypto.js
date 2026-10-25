import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function encrypt(plaintext, masterKeyHex) {
  const key = Buffer.from(masterKeyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Master key must be a 32-byte (64 hex characters) string.');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encryptedPayload, masterKeyHex) {
  const key = Buffer.from(masterKeyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Master key must be a 32-byte (64 hex characters) string.');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format. Expected iv:authTag:cipher.');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = Buffer.from(parts[2], 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedText),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

export function generateHmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

export function verifyHmac(data, secret, expectedSignature) {
  const actualSignature = generateHmac(data, secret);
  const actualBuffer = Buffer.from(actualSignature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function generateRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 100000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
  return `${iterations}:${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  const parts = storedHash.split(':');
  if (parts.length !== 3) return false;

  const iterations = parseInt(parts[0], 10);
  const salt = parts[1];
  const originalHash = parts[2];

  const checkHash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(checkHash, 'hex'), Buffer.from(originalHash, 'hex'));
}
