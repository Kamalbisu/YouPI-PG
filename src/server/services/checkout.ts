import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db, type Tx } from "@/lib/db";
import { AppError, conflict, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { env, simulatorEnabled } from "@/lib/env";
import { randomToken } from "@/lib/ids";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parse } from "@/lib/validation";
import { systemCtx, type Ctx } from "@/server/auth/types";
import { credentialsForAttempt, platformCredentials, webhookUrl } from "@/server/payments/credentials";
import { getProvider, signSimulatorBody, SIMULATOR_SIGNATURE_HEADER, type ProviderId } from "@/server/payments";
import { ingestWebhook, type WebhookIngestResult } from "./webhooks";
import { getPaymentStatus, type PaymentOutcome, type PaymentStatusView } from "./payment-verification";

/** Payment methods a business can enable. `checkout` is the provider's hosted card / netbanking / wallet / UPI sheet. */
export const PAYMENT_METHODS = ["upi_gpay", "upi_phonepe", "upi_paytm", "upi_other", "checkout"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number] | "simulator";

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  upi_gpay: "Google Pay",
  upi_phonepe: "PhonePe",
  upi_paytm: "Paytm",
  upi_other: "Other UPI app",
  checkout: "Card, netbanking and wallets",
  simulator: "Test payment (development only)",
};

const UPI_APP: Record<string, "gpay" | "phonepe" | "paytm" | "other"> = { upi_gpay: "gpay", upi_phonepe: "phonepe", upi_paytm: "paytm", upi_other: "other" };

/** Methods offered when a business has no config row of its own and the platform (environment) credentials are used. */
const PLATFORM_METHODS: PaymentMethod[] = ["upi_gpay", "upi_phonepe", "upi_paytm", "upi_other", "checkout"];

const OPEN = ["CREATED", "PENDING", "AUTHORIZED"] as const;

export interface PaymentOption {
  provider: ProviderId;
  method: PaymentMethod;
  label: string;
}

export interface PaymentOptions {
  publicId: string;
  orderCode: string;
  businessName: string;
  currency: string;
  totalMinor: number;
  expiresAt: string;
  orderStatus: string;
  /** False when the order is expired, cancelled or already paid, or the business cannot take payments. */
  payable: boolean;
  reason: string | null;
  options: PaymentOption[];
}

interface ResolvedConfig {
  configId: string | null;
}

/**
 * Provider selection logic:
 *  1. A per-business PaymentProviderConfig for the provider wins. It is offered only when isActive, it has
 *     encrypted credentials, and the method is in its enabled methods list.
 *  2. A business with NO config row for a provider falls back to the platform (environment) credentials for
 *     that provider, if present. A business that has a row for the provider but disabled it never falls back.
 *  3. DEV_SIMULATOR is offered only when simulatorEnabled() (never in production).
 */
async function listOptionsForBusiness(businessId: string): Promise<(PaymentOption & ResolvedConfig)[]> {
  const configs = await db.paymentProviderConfig.findMany({ where: { businessId, provider: { in: ["RAZORPAY", "CASHFREE"] } } });
  const out: (PaymentOption & ResolvedConfig)[] = [];
  for (const provider of ["RAZORPAY", "CASHFREE"] as const) {
    const cfg = configs.find((c) => c.provider === provider);
    if (cfg) {
      if (!cfg.isActive || !cfg.keyId || !cfg.secretEnc) continue;
      for (const m of cfg.methods) {
        if ((PAYMENT_METHODS as readonly string[]).includes(m)) out.push({ provider, method: m as PaymentMethod, label: METHOD_LABELS[m as PaymentMethod], configId: cfg.id });
      }
    } else if (platformCredentials(provider)) {
      for (const m of PLATFORM_METHODS) out.push({ provider, method: m, label: METHOD_LABELS[m], configId: null });
    }
  }
  if (simulatorEnabled()) out.push({ provider: "DEV_SIMULATOR", method: "simulator", label: METHOD_LABELS.simulator, configId: null });
  return out;
}

async function loadPayableOrder(publicId: string) {
  const order = await db.order.findUnique({ where: { publicId }, include: { business: { select: { id: true, name: true, status: true, clientId: true, client: { select: { status: true } } } } } });
  if (!order) throw notFound("Order");
  return order;
}

function payability(o: { status: string; expiresAt: Date; business: { status: string; client: { status: string } } }): string | null {
  if (o.status === "PAID" || o.status === "PARTIALLY_REFUNDED" || o.status === "REFUNDED") return "This order has already been paid";
  if (o.status === "CANCELLED") return "This order was cancelled";
  if (o.status === "EXPIRED" || o.expiresAt.getTime() <= Date.now()) return "This order has expired";
  if (o.business.status !== "ACTIVE" || o.business.client.status !== "ACTIVE") return "This business cannot take payments right now";
  return null;
}

/** Customer facing: which ways can this order be paid. Only configured, active, enabled methods. */
export async function getPaymentOptions(publicId: string): Promise<PaymentOptions> {
  const id = parse(z.string().trim().min(8).max(100), publicId);
  const order = await loadPayableOrder(id);
  const reason = payability(order);
  const options = reason ? [] : (await listOptionsForBusiness(order.businessId)).map(({ provider, method, label }) => ({ provider, method, label }));
  return {
    publicId: order.publicId,
    orderCode: order.orderCode,
    businessName: order.business.name,
    currency: order.currency,
    totalMinor: order.totalMinor,
    expiresAt: order.expiresAt.toISOString(),
    orderStatus: order.status,
    payable: reason === null && options.length > 0,
    reason: reason ?? (options.length === 0 ? "No payment method is available for this business" : null),
    options,
  };
}

const startSchema = z.object({
  publicId: z.string().trim().min(8).max(100),
  provider: z.enum(["RAZORPAY", "CASHFREE", "DEV_SIMULATOR"]),
  method: z.enum(["upi_gpay", "upi_phonepe", "upi_paytm", "upi_other", "checkout", "simulator"]),
  idempotencyKey: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/),
});

export interface StartPaymentResult {
  attemptId: string;
  provider: ProviderId;
  method: PaymentMethod;
  /** Which client SDK the browser must open. */
  checkoutKind: "razorpay_checkout" | "cashfree_session" | "simulator";
  mode: "TEST" | "LIVE";
  providerOrderId: string;
  /** Razorpay public key id (never the secret). */
  publicKeyId: string | null;
  /** Cashfree payment_session_id. */
  sessionId: string | null;
  /** Preselect this UPI app in the provider checkout (UPI methods only). */
  upiApp: "gpay" | "phonepe" | "paytm" | "other" | null;
  amountMinor: number;
  currency: string;
  expiresAt: string;
  businessName: string;
  orderCode: string;
  customer: { name: string | null; phone: string | null; email: string | null };
  returnUrl: string;
  replayed: boolean;
}

async function lockOrder(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
}

async function toResult(attempt: { id: string; provider: ProviderId; method: string | null; configId: string | null; providerOrderId: string | null; providerSessionId: string | null; amountMinor: number; currency: string; expiresAt: Date }, order: { publicId: string; orderCode: string; customerName: string | null; customerPhone: string | null; customerEmail: string | null; business: { name: string } }, replayed: boolean): Promise<StartPaymentResult> {
  const creds = await credentialsForAttempt(attempt.provider, attempt.configId);
  const method = (attempt.method ?? "checkout") as PaymentMethod;
  return {
    attemptId: attempt.id,
    provider: attempt.provider,
    method,
    checkoutKind: attempt.provider === "RAZORPAY" ? "razorpay_checkout" : attempt.provider === "CASHFREE" ? "cashfree_session" : "simulator",
    mode: creds.mode,
    providerOrderId: attempt.providerOrderId!,
    publicKeyId: attempt.provider === "RAZORPAY" ? creds.keyId : attempt.provider === "DEV_SIMULATOR" ? "simulator" : null,
    sessionId: attempt.providerSessionId,
    upiApp: UPI_APP[method] ?? null,
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
    expiresAt: attempt.expiresAt.toISOString(),
    businessName: order.business.name,
    orderCode: order.orderCode,
    customer: { name: order.customerName, phone: order.customerPhone, email: order.customerEmail },
    returnUrl: `${env().APP_URL.replace(/\/+$/, "")}/pay/${order.publicId}`,
    replayed,
  };
}

/**
 * Starts a payment attempt for an order. One open attempt per order is guaranteed by the order row lock plus
 * the partial unique index payment_attempts_one_open_per_order. The provider order is created with the amount
 * taken from the DB order (never from the client). Returns only what the browser needs: no secrets.
 */
export async function startPayment(ctx: Ctx, input: unknown): Promise<StartPaymentResult> {
  const d = parse(startSchema, input);
  if (d.provider === "DEV_SIMULATOR" !== (d.method === "simulator")) throw new AppError("VALIDATION", "Invalid payment method for this provider");
  await enforceRateLimit(`pay:start:ip:${ctx.ip ?? "unknown"}`, 30, 300, "Too many payment attempts. Please wait a moment.");

  const order = await loadPayableOrder(d.publicId);
  const attemptKey = `${order.id}:${d.idempotencyKey}`;

  // Idempotent replay: same key returns the same attempt.
  const existingByKey = await db.paymentAttempt.findUnique({ where: { idempotencyKey: attemptKey } });
  if (existingByKey) {
    if (!existingByKey.providerOrderId) throw conflict("Payment is being prepared, please retry in a moment");
    return toResult(existingByKey, order, true);
  }

  const reason = payability(order);
  if (reason) throw conflict(reason, { reason: "ORDER_NOT_PAYABLE" });

  // Provider/method must be among the currently offered options (config active, method enabled).
  const choice = (await listOptionsForBusiness(order.businessId)).find((o) => o.provider === d.provider && o.method === d.method);
  if (!choice) throw new AppError("BAD_REQUEST", "This payment method is not available", { reason: "METHOD_NOT_AVAILABLE" });
  if (d.provider === "DEV_SIMULATOR" && !simulatorEnabled()) throw new AppError("FORBIDDEN", "The payment simulator is not available");

  // Phase 1: reserve the attempt row under the order lock.
  type Phase1 = { reuse: Awaited<ReturnType<typeof db.paymentAttempt.findUnique>> } | { attemptId: string };
  const phase1: Phase1 = await db.$transaction(async (tx) => {
    await lockOrder(tx, order.id);
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, expiresAt: true } });
    if (fresh.status !== "PENDING_PAYMENT" || fresh.expiresAt.getTime() <= Date.now()) throw conflict("This order can no longer be paid", { reason: "ORDER_NOT_PAYABLE" });
    const open = await tx.paymentAttempt.findMany({ where: { orderId: order.id, status: { in: [...OPEN] } } });
    for (const o of open) {
      const sameChoice = o.provider === d.provider && o.method === d.method && o.configId === choice.configId && o.providerOrderId;
      if (sameChoice) return { reuse: o };
      if (!o.providerOrderId && Date.now() - o.createdAt.getTime() < 30_000) throw conflict("Payment is being prepared, please retry in a moment");
      // A different method was chosen: the earlier attempt is replaced. If the customer had already paid on it,
      // a late verified success is still recorded (see applyPaymentEvent).
      await tx.paymentAttempt.update({ where: { id: o.id }, data: { status: "CANCELLED", failureReason: "Replaced by a new attempt" } });
      await tx.paymentStatusHistory.create({ data: { attemptId: o.id, fromStatus: o.status, toStatus: "CANCELLED", source: "SYSTEM", note: "Replaced by a new attempt" } });
    }
    const created = await tx.paymentAttempt.create({
      data: {
        orderId: order.id,
        configId: choice.configId,
        provider: d.provider,
        method: d.method,
        amountMinor: order.totalMinor,
        currency: order.currency,
        idempotencyKey: attemptKey,
        expiresAt: order.expiresAt,
      },
    });
    await tx.paymentStatusHistory.create({ data: { attemptId: created.id, fromStatus: null, toStatus: "CREATED", source: "SYSTEM", note: `Started with ${d.provider} (${d.method})` } });
    await audit(ctx, { action: "payment.attempt_start", entityType: "PaymentAttempt", entityId: created.id, clientId: order.business.clientId, metadata: { orderId: order.id, provider: d.provider, method: d.method } }, tx);
    return { attemptId: created.id };
  }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("A payment is already in progress for this order");
    throw e;
  });

  if ("reuse" in phase1 && phase1.reuse) return toResult(phase1.reuse, order, true);
  const attemptId = (phase1 as { attemptId: string }).attemptId;

  // Phase 2: create the provider order outside any DB lock.
  const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  try {
    const creds = await credentialsForAttempt(d.provider, choice.configId);
    const base = env().APP_URL.replace(/\/+$/, "");
    const po = await getProvider(d.provider).createProviderOrder(creds, {
      receipt: `${order.orderCode}-${attempt.id.slice(-6)}`,
      amountMinor: order.totalMinor,
      currency: order.currency,
      customer: { name: order.customerName, phone: order.customerPhone, email: order.customerEmail },
      returnUrl: `${base}/pay/${order.publicId}`,
      notifyUrl: webhookUrl(d.provider, choice.configId),
    });
    const updated = await db.paymentAttempt.update({ where: { id: attemptId }, data: { providerOrderId: po.providerOrderId, providerSessionId: po.sessionId ?? null } });
    return toResult(updated, order, false);
  } catch (e) {
    const message = e instanceof AppError ? e.message : "Could not start the payment";
    await db.$transaction(async (tx) => {
      const at = await tx.paymentAttempt.findUnique({ where: { id: attemptId } });
      if (at && (OPEN as readonly string[]).includes(at.status) && !at.providerOrderId) {
        await tx.paymentAttempt.update({ where: { id: attemptId }, data: { status: "FAILED", failureReason: message.slice(0, 200) } });
        await tx.paymentStatusHistory.create({ data: { attemptId, fromStatus: at.status, toStatus: "FAILED", source: "SYSTEM", note: "Provider order could not be created" } });
      }
    });
    if (e instanceof AppError) throw e;
    throw new AppError("PROVIDER_UNAVAILABLE", "The payment provider is not reachable. Please try again.");
  }
}

const cancelSchema = z.object({ publicId: z.string().trim().min(8).max(100), attemptId: z.string().trim().min(1).max(64) });

/**
 * Customer cancels the open attempt (closes the checkout sheet). Touches only attempt status, never the order,
 * and never overrides a payment that was already verified.
 */
export async function cancelAttempt(ctx: Ctx, input: unknown): Promise<{ cancelled: boolean }> {
  const d = parse(cancelSchema, input);
  await enforceRateLimit(`pay:cancel:ip:${ctx.ip ?? "unknown"}`, 30, 300);
  const order = await db.order.findUnique({ where: { publicId: d.publicId }, select: { id: true } });
  if (!order) throw notFound("Order");
  return db.$transaction(async (tx) => {
    await lockOrder(tx, order.id);
    const at = await tx.paymentAttempt.findFirst({ where: { id: d.attemptId, orderId: order.id } });
    if (!at) throw notFound("Payment");
    if (!(OPEN as readonly string[]).includes(at.status)) return { cancelled: false };
    await tx.paymentAttempt.update({ where: { id: at.id }, data: { status: "CANCELLED", failureReason: "Cancelled by customer" } });
    await tx.paymentStatusHistory.create({ data: { attemptId: at.id, fromStatus: at.status, toStatus: "CANCELLED", source: "USER_CANCEL", note: "Customer closed the payment" } });
    return { cancelled: true };
  });
}

const simSchema = z.object({
  publicId: z.string().trim().min(8).max(100),
  attemptId: z.string().trim().min(1).max(64),
  outcome: z.enum(["success", "failure", "cancel"]),
});

/**
 * Development simulator completion. Refuses unless simulatorEnabled() (false in production). It does NOT
 * mark anything paid itself: it builds an event, signs it with a key derived from APP_SECRET and feeds the
 * same webhook ingestion (signature check, WebhookEvent record, applyPaymentEvent) real webhooks use.
 */
export async function simulatorComplete(publicId: string, attemptId: string, outcome: "success" | "failure" | "cancel", ctx: Ctx = systemCtx()): Promise<{ result: WebhookIngestResult; outcome: PaymentOutcome | null; status: PaymentStatusView }> {
  if (!simulatorEnabled()) throw new AppError("FORBIDDEN", "The payment simulator is not available");
  const d = parse(simSchema, { publicId, attemptId, outcome });
  const order = await db.order.findUnique({ where: { publicId: d.publicId }, select: { id: true } });
  if (!order) throw notFound("Order");
  const attempt = await db.paymentAttempt.findFirst({ where: { id: d.attemptId, orderId: order.id, provider: "DEV_SIMULATOR" } });
  if (!attempt || !attempt.providerOrderId) throw notFound("Payment");
  const type = d.outcome === "success" ? "payment.success" : d.outcome === "failure" ? "payment.failed" : "payment.cancelled";
  const raw = JSON.stringify({
    type,
    eventId: `sim_evt_${randomToken(9)}`,
    providerOrderId: attempt.providerOrderId,
    providerPaymentId: `sim_pay_${attempt.id}`,
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
    method: "simulator",
    reason: d.outcome === "failure" ? "Simulated failure" : d.outcome === "cancel" ? "Simulated cancel" : undefined,
  });
  const res = await ingestWebhook(ctx, { provider: "DEV_SIMULATOR", rawBody: raw, headers: { [SIMULATOR_SIGNATURE_HEADER]: signSimulatorBody(raw) } });
  return { result: res, outcome: res.outcome, status: await getPaymentStatus(d.publicId) };
}
