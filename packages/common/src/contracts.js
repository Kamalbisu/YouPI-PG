export const DefaultBranding = Object.freeze({
  appName: 'YOUPI PG',
  primaryColor: '#2563eb',
  logoUrl: null
});

export function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

export function isValidEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(norm);
}

export function normalizeMobile(mobile) {
  if (!mobile) return '';
  const cleaned = String(mobile).replace(/\D/g, '');
  if (cleaned.length >= 10) {
    return cleaned.slice(-10);
  }
  return cleaned;
}

export function isValidMobile(mobile) {
  const norm = normalizeMobile(mobile);
  return /^[6-9]\d{9}$/.test(norm);
}

export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6;
}

