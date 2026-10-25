import crypto from 'node:crypto';

export function calculateObservationFingerprint(input) {
  let entropy;
  if (input.bankReferenceNumber && input.bankReferenceNumber.trim().length > 0) {
    entropy = `REF:${input.bankReferenceNumber.trim().toUpperCase()}`;
  } else {
    const bucket = Math.floor(input.observedAt.getTime() / 60000);
    entropy = `TIME_BUCKET:${bucket}:${input.source || ''}`;
  }

  const raw = `${input.receivingAccountId}:${input.amountPaise.toString()}:${entropy}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}
