import { PaymentStatus, PublicPaymentOutcome, PaymentMethod, ObserverSource, TicketStatus, SenderType } from './enums.js';

export interface CreatePaymentRequest {
  orderId: string;
  amount: string | number;
  currency?: string;
  returnUrl?: string;
  method?: PaymentMethod;
  customer?: {
    phoneNumber: string;
    fullName?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentResponse {
  paymentId: string;
  orderId: string;
  amount: string;
  amountPaise: string;
  currency: string;
  status: PaymentStatus;
  checkoutUrl: string;
}

export interface QueryPaymentResponse {
  paymentId: string;
  orderId: string;
  amount: string;
  currency: string;
  status: PublicPaymentOutcome | PaymentStatus;
  method: PaymentMethod;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckoutStateResponse {
  paymentId: string;
  orderId: string;
  merchantName: string;
  amount: string;
  amountPaise: string;
  currency: string;
  status: PaymentStatus;
  method: PaymentMethod;
  queuePosition: number;
  timeRemainingSeconds: number;
  upiUri?: string;
  payeeVpa?: string;
  payeeName?: string;
  canClickPaymentDone: boolean;
  branding: {
    appName: string;
    primaryColor: string;
    logoUrl?: string;
  };
}

export interface WebhookEventPayload {
  event: PublicPaymentOutcome;
  paymentId: string;
  orderId: string;
  amount: string;
  amountPaise: number;
  currency: string;
  method: PaymentMethod;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AndroidObservationPayload {
  deviceId: string;
  source: ObserverSource.ANDROID_OBSERVER;
  amountPaise: number;
  observedAt: string;
  observationId?: string;
  senderVpa?: string;
  bankReferenceNumber?: string;
  rawNotification?: Record<string, unknown>;
}

export interface AndroidHeartbeatPayload {
  deviceId: string;
  timestamp: string;
  batteryLevel?: number;
  appVersion?: string;
}

export interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  mobileNumber: string;
  status: string;
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerRegisterRequest {
  name: string;
  email: string;
  mobileNumber: string;
  password: string;
}

export interface CustomerLoginRequest {
  identifier?: string;
  email?: string;
  mobileNumber?: string;
  password: string;
}

export interface CustomerSessionDto {
  id: string;
  customerId: string;
  token: string;
  expiresAt: string;
  isActive: boolean;
  createdAt: string;
}

export function normalizeEmail(email: string | null | undefined): string {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string | null | undefined): boolean {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(norm);
}

export function normalizeMobile(mobile: string | null | undefined): string {
  if (!mobile) return '';
  const cleaned = String(mobile).replace(/\D/g, '');
  if (cleaned.length >= 10) {
    return cleaned.slice(-10);
  }
  return cleaned;
}

export function isValidMobile(mobile: string | null | undefined): boolean {
  const norm = normalizeMobile(mobile);
  return /^[6-9]\d{9}$/.test(norm);
}

export function isValidPassword(password: string | null | undefined): boolean {
  return typeof password === 'string' && password.length >= 6;
}

export interface SupportTicketSummary {
  id: string;
  subject: string;
  status: TicketStatus;
  paymentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketMessageDto {
  id: string;
  ticketId: string;
  senderType: SenderType;
  senderId: string;
  message: string;
  createdAt: string;
}
