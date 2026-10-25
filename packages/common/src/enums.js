export const PaymentStatus = Object.freeze({
  INITIATED: 'INITIATED',
  QUEUED: 'QUEUED',
  ACTIVE: 'ACTIVE',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

export const PublicPaymentOutcome = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

export const PaymentMethod = Object.freeze({
  UPI: 'UPI',
  COD: 'COD',
  CASH_COUNTER: 'CASH_COUNTER',
  CARD_COUNTER: 'CARD_COUNTER'
});

export const SellingMode = Object.freeze({
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE'
});

export const ObserverSource = Object.freeze({
  GMAIL: 'GMAIL',
  GOOGLE_MESSAGES: 'GOOGLE_MESSAGES',
  ANDROID_OBSERVER: 'ANDROID_OBSERVER',
  SMS_GATEWAY: 'SMS_GATEWAY',
  MANUAL_COUNTER: 'MANUAL_COUNTER'
});

export const ObservationAttributionStatus = Object.freeze({
  UNATTRIBUTED: 'UNATTRIBUTED',
  ATTRIBUTED: 'ATTRIBUTED',
  LATE_UNMATCHED: 'LATE_UNMATCHED',
  DUPLICATE_IGNORED: 'DUPLICATE_IGNORED'
});

export const TicketStatus = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED'
});

export const SenderType = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN'
});

export const AuditActorType = Object.freeze({
  SYSTEM: 'SYSTEM',
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN',
  OBSERVER: 'OBSERVER'
});
