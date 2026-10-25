export function toPaise(rupees: string | number): bigint {
  if (typeof rupees === 'number') {
    if (!Number.isFinite(rupees) || isNaN(rupees)) {
      throw new Error(`Invalid monetary amount: ${rupees}`);
    }
    rupees = rupees.toString();
  }

  const clean = rupees.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) {
    throw new Error(`Invalid INR rupee format: "${rupees}". Must be non-negative with max 2 decimals.`);
  }

  const parts = clean.split('.');
  const whole = BigInt(parts[0] || '0');
  const fractionStr = parts[1] || '';
  const fraction = BigInt(fractionStr.padEnd(2, '0'));

  const totalPaise = whole * 100n + fraction;
  if (totalPaise <= 0n) {
    throw new Error(`Monetary amount must be strictly greater than 0: ${rupees}`);
  }

  return totalPaise;
}

export function toRupeesString(paise: bigint | number): string {
  const p = typeof paise === 'number' ? BigInt(Math.floor(paise)) : paise;
  if (p < 0n) {
    throw new Error(`Negative paise value not permitted: ${p}`);
  }

  const whole = p / 100n;
  const fraction = p % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

export function formatINR(paise: bigint | number): string {
  return `₹${toRupeesString(paise)}`;
}
