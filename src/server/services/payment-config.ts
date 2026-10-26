import { z } from "zod";
import { db } from "@/lib/db";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { conflict, notFound, badRequest } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parse } from "@/lib/validation";
import { assertBusinessAccess, requireActor, requireAdmin } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { configCredentials, platformCredentials, webhookUrl } from "@/server/payments/credentials";
import { getProvider } from "@/server/payments";
import { PAYMENT_METHODS, METHOD_LABELS } from "./checkout";

/**
 * Provider selection logic (see also checkout.ts):
 *  - A per-business config row for a provider wins. It is offered only while isActive with credentials and
 *    only for its enabled methods.
 *  - A business with NO row for a provider uses the platform (environment) credentials when present.
 *  - DEV_SIMULATOR exists only when simulatorEnabled() and is not configurable here.
 */

const providerSchema = z.enum(["RAZORPAY", "CASHFREE"]);
const idField = z.string().trim().min(1).max(64);
const methodsSchema = z.array(z.enum(PAYMENT_METHODS)).max(PAYMENT_METHODS.length);

export interface PaymentConfigView {
  id: string | null;
  businessId: string;
  provider: "RAZORPAY" | "CASHFREE";
  mode: "TEST" | "LIVE";
  isActive: boolean;
  /** Masked public key id, e.g. "••••AbCd". The secret is never returned. */
  keyIdMasked: string | null;
  hasSecret: boolean;
  hasWebhookSecret: boolean;
  merchantLabel: string | null;
  methods: string[];
  lastVerifiedAt: string | null;
  /** Admin only. */
  webhookUrl: string | null;
  /** True when this provider is offered through the platform's environment credentials (no row of its own). */
  usesPlatformCredentials: boolean;
}

type CfgRow = {
  id: string;
  businessId: string;
  provider: "RAZORPAY" | "CASHFREE" | "DEV_SIMULATOR";
  mode: "TEST" | "LIVE";
  isActive: boolean;
  keyId: string | null;
  secretEnc: string | null;
  webhookSecretEnc: string | null;
  merchantLabel: string | null;
  methods: string[];
  lastVerifiedAt: Date | null;
};

function toView(cfg: CfgRow, includeUrl: boolean): PaymentConfigView {
  return {
    id: cfg.id,
    businessId: cfg.businessId,
    provider: cfg.provider as "RAZORPAY" | "CASHFREE",
    mode: cfg.mode,
    isActive: cfg.isActive,
    keyIdMasked: maskSecret(cfg.keyId),
    hasSecret: Boolean(cfg.secretEnc),
    hasWebhookSecret: Boolean(cfg.webhookSecretEnc),
    merchantLabel: cfg.merchantLabel,
    methods: cfg.methods,
    lastVerifiedAt: cfg.lastVerifiedAt?.toISOString() ?? null,
    webhookUrl: includeUrl ? webhookUrl(cfg.provider, cfg.id) : null,
    usesPlatformCredentials: false,
  };
}

function platformView(businessId: string, provider: "RAZORPAY" | "CASHFREE"): PaymentConfigView {
  const p = platformCredentials(provider);
  return {
    id: null,
    businessId,
    provider,
    mode: p?.mode ?? "TEST",
    isActive: Boolean(p),
    keyIdMasked: null,
    hasSecret: Boolean(p),
    hasWebhookSecret: Boolean(p?.webhookSecret),
    merchantLabel: null,
    methods: p ? [...PAYMENT_METHODS] : [],
    lastVerifiedAt: null,
    webhookUrl: null,
    usesPlatformCredentials: Boolean(p),
  };
}

/**
 * Per-provider status for a business. Admin gets webhook URLs; a client (payments.view) gets status only
 * (active, mode, masked key, methods) and never URLs or any secret material.
 */
export async function listPaymentConfigs(ctx: Ctx, input: unknown): Promise<{ businessId: string; businessName: string; configs: PaymentConfigView[]; methodLabels: Record<string, string> }> {
  const actor = requireActor(ctx);
  const { businessId } = parse(z.object({ businessId: idField }), input);
  const business = await assertBusinessAccess(ctx, businessId, actor.role === "CLIENT" ? "payments.view" : undefined);
  const isAdmin = actor.role === "SUPER_ADMIN";
  const rows = await db.paymentProviderConfig.findMany({ where: { businessId, provider: { in: ["RAZORPAY", "CASHFREE"] } } });
  const configs = (["RAZORPAY", "CASHFREE"] as const).map((p) => {
    const row = rows.find((r) => r.provider === p);
    return row ? toView(row, isAdmin) : platformView(businessId, p);
  });
  return { businessId, businessName: business.name, configs, methodLabels: METHOD_LABELS };
}

const saveSchema = z.object({
  businessId: idField,
  provider: providerSchema,
  mode: z.enum(["TEST", "LIVE"]),
  keyId: z.string().trim().min(4).max(200).optional(),
  secret: z.string().min(4).max(500).optional(),
  webhookSecret: z.string().min(4).max(500).optional(),
  merchantLabel: z.string().trim().max(100).optional(),
  methods: methodsSchema.optional(),
});

/**
 * Admin: create or update a business's config for one provider. Secrets are encrypted at rest and omitted
 * from the response and from the audit metadata. Omitted secret fields keep their stored value.
 * Changing credentials or mode deactivates the config and clears lastVerifiedAt so it must be verified and
 * re-activated deliberately. LIVE mode requires an admin (this function is admin only).
 */
export async function savePaymentConfig(ctx: Ctx, input: unknown): Promise<PaymentConfigView> {
  requireAdmin(ctx);
  const d = parse(saveSchema, input);
  const business = await db.business.findUnique({ where: { id: d.businessId }, select: { id: true, clientId: true } });
  if (!business) throw notFound("Business");
  const existing = await db.paymentProviderConfig.findUnique({ where: { businessId_provider: { businessId: d.businessId, provider: d.provider } } });
  if (!existing && (!d.keyId || !d.secret)) throw badRequest("Key id and secret are required for a new configuration");
  if (d.provider === "RAZORPAY" && d.keyId) {
    const live = d.keyId.startsWith("rzp_live");
    const test = d.keyId.startsWith("rzp_test");
    if (!live && !test) throw badRequest("Razorpay key ids start with rzp_test_ or rzp_live_");
    if (live && d.mode !== "LIVE") throw badRequest("A live key id requires LIVE mode");
    if (test && d.mode !== "TEST") throw badRequest("A test key id requires TEST mode");
  }
  const credsChanged = Boolean(d.keyId || d.secret || d.webhookSecret) || (existing != null && existing.mode !== d.mode);
  const data = {
    mode: d.mode,
    ...(d.keyId ? { keyId: d.keyId } : {}),
    ...(d.secret ? { secretEnc: encryptSecret(d.secret) } : {}),
    // Cashfree signs webhooks with the API secret key, so default the webhook secret to it.
    ...(d.webhookSecret ? { webhookSecretEnc: encryptSecret(d.webhookSecret) } : d.provider === "CASHFREE" && d.secret ? { webhookSecretEnc: encryptSecret(d.secret) } : {}),
    ...(d.merchantLabel !== undefined ? { merchantLabel: d.merchantLabel || null } : {}),
    ...(d.methods ? { methods: d.methods } : {}),
    ...(credsChanged ? { isActive: false, lastVerifiedAt: null } : {}),
  };
  const saved = await db.$transaction(async (tx) => {
    const row = existing
      ? await tx.paymentProviderConfig.update({ where: { id: existing.id }, data })
      : await tx.paymentProviderConfig.create({ data: { businessId: d.businessId, provider: d.provider, methods: d.methods ?? ["checkout"], ...data } });
    await audit(
      ctx,
      {
        action: existing ? "payment_config.update" : "payment_config.create",
        entityType: "PaymentProviderConfig",
        entityId: row.id,
        clientId: business.clientId,
        metadata: {
          businessId: d.businessId,
          provider: d.provider,
          mode: d.mode,
          credentialsChanged: Boolean(d.keyId || d.secret || d.webhookSecret),
          methods: row.methods,
          deactivated: credsChanged && existing?.isActive === true,
        },
      },
      tx,
    );
    return row;
  });
  return toView(saved, true);
}

const toggleSchema = z.object({ id: idField, active: z.boolean() });

/** Admin: activate or deactivate. Activation needs stored credentials, at least one method and, for LIVE mode, a successful verification. */
export async function setPaymentConfigActive(ctx: Ctx, input: unknown): Promise<PaymentConfigView> {
  requireAdmin(ctx);
  const d = parse(toggleSchema, input);
  const cfg = await db.paymentProviderConfig.findUnique({ where: { id: d.id }, include: { business: { select: { clientId: true } } } });
  if (!cfg || cfg.provider === "DEV_SIMULATOR") throw notFound("Payment configuration");
  if (d.active) {
    if (!cfg.keyId || !cfg.secretEnc) throw conflict("Add credentials before activating");
    if (cfg.methods.length === 0) throw conflict("Enable at least one payment method before activating");
    if (cfg.mode === "LIVE" && !cfg.lastVerifiedAt) throw conflict("Verify the credentials before activating LIVE mode");
  }
  const row = await db.$transaction(async (tx) => {
    const r = await tx.paymentProviderConfig.update({ where: { id: cfg.id }, data: { isActive: d.active } });
    await audit(ctx, { action: d.active ? "payment_config.activate" : "payment_config.deactivate", entityType: "PaymentProviderConfig", entityId: cfg.id, clientId: cfg.business.clientId, metadata: { businessId: cfg.businessId, provider: cfg.provider, mode: cfg.mode } }, tx);
    return r;
  });
  return toView(row, true);
}

const methodsInput = z.object({ id: idField, methods: methodsSchema });

/** Admin: set which customer methods are offered for this config. */
export async function setPaymentConfigMethods(ctx: Ctx, input: unknown): Promise<PaymentConfigView> {
  requireAdmin(ctx);
  const d = parse(methodsInput, input);
  const cfg = await db.paymentProviderConfig.findUnique({ where: { id: d.id }, include: { business: { select: { clientId: true } } } });
  if (!cfg || cfg.provider === "DEV_SIMULATOR") throw notFound("Payment configuration");
  const methods = [...new Set(d.methods)];
  if (cfg.isActive && methods.length === 0) throw conflict("Deactivate the configuration instead of removing every method");
  const row = await db.$transaction(async (tx) => {
    const r = await tx.paymentProviderConfig.update({ where: { id: cfg.id }, data: { methods } });
    await audit(ctx, { action: "payment_config.methods", entityType: "PaymentProviderConfig", entityId: cfg.id, clientId: cfg.business.clientId, metadata: { businessId: cfg.businessId, provider: cfg.provider, methods } }, tx);
    return r;
  });
  return toView(row, true);
}

/**
 * Admin: harmless authenticated call to the provider (list one order / payment) to prove the credentials work.
 * Records lastVerifiedAt on success. Provider failures come back as { ok:false } with a safe message, not an exception,
 * so the UI can show them inline.
 */
export async function verifyPaymentConfig(ctx: Ctx, input: unknown): Promise<{ ok: boolean; message: string; config: PaymentConfigView }> {
  requireAdmin(ctx);
  const d = parse(z.object({ id: idField }), input);
  await enforceRateLimit(`payment-config-verify:${ctx.actor!.userId}`, 20, 600);
  const cfg = await db.paymentProviderConfig.findUnique({ where: { id: d.id }, include: { business: { select: { clientId: true } } } });
  if (!cfg || cfg.provider === "DEV_SIMULATOR") throw notFound("Payment configuration");
  let ok = false;
  let message = "Credentials verified";
  try {
    await getProvider(cfg.provider).verifyCredentials(configCredentials(cfg));
    ok = true;
  } catch (e) {
    message = e instanceof Error ? e.message : "Verification failed";
  }
  const row = await db.$transaction(async (tx) => {
    const r = ok ? await tx.paymentProviderConfig.update({ where: { id: cfg.id }, data: { lastVerifiedAt: new Date() } }) : cfg;
    await audit(ctx, { action: "payment_config.verify", entityType: "PaymentProviderConfig", entityId: cfg.id, clientId: cfg.business.clientId, metadata: { businessId: cfg.businessId, provider: cfg.provider, ok } }, tx);
    return r;
  });
  return { ok, message, config: toView(row, true) };
}

/** Admin: delete a config that has never been used. A used config can only be deactivated (history and refunds need its credentials). */
export async function deletePaymentConfig(ctx: Ctx, input: unknown): Promise<{ deleted: true }> {
  requireAdmin(ctx);
  const d = parse(z.object({ id: idField }), input);
  const cfg = await db.paymentProviderConfig.findUnique({ where: { id: d.id }, include: { business: { select: { clientId: true } } } });
  if (!cfg) throw notFound("Payment configuration");
  const used = await db.paymentAttempt.count({ where: { configId: cfg.id } });
  if (used > 0) throw conflict("This configuration has payment history. Deactivate it instead.");
  await db.$transaction(async (tx) => {
    await tx.paymentProviderConfig.delete({ where: { id: cfg.id } });
    await audit(ctx, { action: "payment_config.delete", entityType: "PaymentProviderConfig", entityId: cfg.id, clientId: cfg.business.clientId, metadata: { businessId: cfg.businessId, provider: cfg.provider } }, tx);
  });
  return { deleted: true };
}

/** Admin overview: every business with its provider status, for the /admin/payments page. */
export async function listPaymentOverview(ctx: Ctx, input: unknown) {
  requireAdmin(ctx);
  const q = parse(z.object({ q: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }), input ?? {});
  const where = q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" as const } }, { client: { name: { contains: q.q, mode: "insensitive" as const } } }] } : {};
  const [rows, total] = await Promise.all([
    db.business.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, name: true, status: true, client: { select: { id: true, name: true } }, paymentConfigs: { select: { provider: true, mode: true, isActive: true, lastVerifiedAt: true } } },
    }),
    db.business.count({ where }),
  ]);
  return {
    items: rows.map((b) => ({
      businessId: b.id,
      businessName: b.name,
      status: b.status,
      clientId: b.client.id,
      clientName: b.client.name,
      providers: (["RAZORPAY", "CASHFREE"] as const).map((p) => {
        const c = b.paymentConfigs.find((x) => x.provider === p);
        return { provider: p, configured: Boolean(c), isActive: c?.isActive ?? false, mode: c?.mode ?? null, verified: Boolean(c?.lastVerifiedAt), platformFallback: !c && Boolean(platformCredentials(p)) };
      }),
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
    pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}
