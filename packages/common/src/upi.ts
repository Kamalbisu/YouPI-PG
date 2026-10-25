import { toRupeesString } from './money.js';

export interface BuildUpiUriOptions {
  payeeVpa: string;
  payeeName: string;
  amountPaise: bigint;
  transactionRef: string;
  transactionNote?: string;
  currency?: string;
}

export function isValidVpa(vpa: string): boolean {
  if (!vpa || typeof vpa !== 'string') return false;
  const clean = vpa.trim();
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/.test(clean);
}

export function buildUpiUri(options: BuildUpiUriOptions): string {
  if (!isValidVpa(options.payeeVpa)) {
    throw new Error(`Invalid payee VPA: ${options.payeeVpa}`);
  }

  const amountStr = toRupeesString(options.amountPaise);

  const params = new URLSearchParams();
  params.set('pa', options.payeeVpa.trim());
  params.set('pn', options.payeeName.trim());
  params.set('am', amountStr);
  const txnId = (options.transactionRef || options.transactionNote || '').trim();
  if (txnId) {
    params.set('tn', txnId);
  }

  return `upi://pay?${params.toString()}`;
}

export interface BuildUpiIntentUriOptions extends BuildUpiUriOptions {
  packageName: string;
}

export function buildUpiIntentUri(options: BuildUpiIntentUriOptions): string {
  if (!options.packageName || !options.packageName.trim()) {
    throw new Error('Package name is required for Android UPI intent URI');
  }
  const upiUri = buildUpiUri(options);
  const query = upiUri.split('?')[1] || '';
  const cleanPackage = options.packageName.trim();
  return `intent://pay?${query}#Intent;scheme=upi;package=${cleanPackage};end`;
}
