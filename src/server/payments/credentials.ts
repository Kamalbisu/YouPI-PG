import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { db } from "@/lib/db";
import type { PaymentProviderConfig } from "@/generated/prisma/client";
import type { ProviderCredentials, ProviderId } from "./types";

/**
 * Credential resolution. Decrypted values only ever live in memory for the duration of a call.
 * - A per-business PaymentProviderConfig (configId set) uses its own encrypted keys.
 * - "Platform" credentials come from the environment and are used only when the business has no config
 *   row for that provider (configId null on the attempt).
 */
export function configCredentials(cfg: Pick<PaymentProviderConfig, "keyId" | "secretEnc" | "webhookSecretEnc" | "mode">): ProviderCredentials {
  if (!cfg.keyId || !cfg.secretEnc) throw new AppError("PAYMENT_ERROR", "Payment credentials are not configured");
  return {
    keyId: cfg.keyId,
    secret: decryptSecret(cfg.secretEnc),
    webhookSecret: cfg.webhookSecretEnc ? decryptSecret(cfg.webhookSecretEnc) : null,
    mode: cfg.mode,
  };
}

/** Environment (platform) credentials for a provider, or null when not configured. */
export function platformCredentials(provider: ProviderId): ProviderCredentials | null {
  const e = env();
  if (provider === "RAZORPAY") {
    if (!e.RAZORPAY_KEY_ID || !e.RAZORPAY_KEY_SECRET) return null;
    return {
      keyId: e.RAZORPAY_KEY_ID,
      secret: e.RAZORPAY_KEY_SECRET,
      webhookSecret: e.RAZORPAY_WEBHOOK_SECRET ?? null,
      mode: e.RAZORPAY_KEY_ID.startsWith("rzp_live") ? "LIVE" : "TEST",
    };
  }
  if (provider === "CASHFREE") {
    if (!e.CASHFREE_APP_ID || !e.CASHFREE_SECRET_KEY) return null;
    return {
      keyId: e.CASHFREE_APP_ID,
      secret: e.CASHFREE_SECRET_KEY,
      // Cashfree signs webhooks with the same secret key.
      webhookSecret: e.CASHFREE_SECRET_KEY,
      mode: e.CASHFREE_ENV === "production" ? "LIVE" : "TEST",
    };
  }
  return { keyId: "simulator", secret: "simulator", webhookSecret: null, mode: "TEST" };
}

/** Credentials for an attempt: its config when set, otherwise the platform credentials. */
export async function credentialsForAttempt(provider: ProviderId, configId: string | null): Promise<ProviderCredentials> {
  if (provider === "DEV_SIMULATOR") return platformCredentials("DEV_SIMULATOR")!;
  if (configId) {
    const cfg = await db.paymentProviderConfig.findUnique({ where: { id: configId } });
    if (!cfg) throw new AppError("PAYMENT_ERROR", "Payment configuration no longer exists");
    return configCredentials(cfg);
  }
  const c = platformCredentials(provider);
  if (!c) throw new AppError("PAYMENT_ERROR", "Payment provider is not configured");
  return c;
}

/** The webhook URL a provider dashboard must be pointed at. Per-business when configId is given. */
export function webhookUrl(provider: ProviderId, configId?: string | null): string {
  const base = env().APP_URL.replace(/\/+$/, "");
  const slug = provider === "RAZORPAY" ? "razorpay" : provider === "CASHFREE" ? "cashfree" : "simulator";
  return configId ? `${base}/api/webhooks/${slug}/${configId}` : `${base}/api/webhooks/${slug}`;
}
