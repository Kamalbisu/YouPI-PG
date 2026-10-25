import crypto from 'node:crypto';
import { ObserverSource, ObservationAttributionStatus } from './enums.js';

export interface CanonicalObservation {
  id: string;
  receivingAccountId: string;
  source: ObserverSource;
  amountPaise: bigint;
  observedAt: Date;
  ingestedAt: Date;
  senderVpa?: string;
  bankReferenceNumber?: string;
  fingerprintHash: string;
  attributionStatus: ObservationAttributionStatus;
  attributedPaymentId?: string;
  rawPayload: Record<string, unknown>;
}

export interface IngestObservationInput {
  receivingAccountId: string;
  source: ObserverSource;
  amountPaise: bigint;
  observedAt: Date;
  senderVpa?: string;
  bankReferenceNumber?: string;
  rawPayload?: Record<string, unknown>;
}

export function calculateObservationFingerprint(input: {
  receivingAccountId: string;
  amountPaise: bigint;
  source?: string;
  bankReferenceNumber?: string;
  observedAt: Date;
}): string {
  let entropy: string;
  if (input.bankReferenceNumber && input.bankReferenceNumber.trim().length > 0) {
    entropy = `REF:${input.bankReferenceNumber.trim().toUpperCase()}`;
  } else {
    const bucket = Math.floor(input.observedAt.getTime() / 60000);
    entropy = `TIME_BUCKET:${bucket}:${input.source || ''}`;
  }

  const raw = `${input.receivingAccountId}:${input.amountPaise.toString()}:${entropy}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}
