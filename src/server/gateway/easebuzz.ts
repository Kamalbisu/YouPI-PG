import { createHash } from "node:crypto";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto";
import { redact } from "@/lib/redact";

/**
 * Easebuzz client: request/response hashing and the HTTP calls.
 * Key and salt come from the environment and are never logged, stored or returned.
 *
 * Every function takes an optional `cfg` so tests can pass fixed credentials; production code
 * uses the environment.
 */

export interface GatewayConfig {
  key: string;
  salt: string;
  env: "test" | "prod";
  /** Hosted checkout host (initiate payment + pay page). */
  payBase: string;
  /** Dashboard API host (retrieve, refund). */
  dashBase: string;
}

const HOSTS = {
  test: { payBase: "https://testpay.easebuzz.in/", dashBase: "https://testdashboard.easebuzz.in/" },
  prod: { payBase: "https://pay.easebuzz.in/", dashBase: "https://dashboard.easebuzz.in/" },
} as const;

/** Credentials from the environment, or null when the gateway is not configured. */
export function gatewayConfig(): GatewayConfig | null {
  const e = env();
  if (!e.EASEBUZZ_KEY || !e.EASEBUZZ_SALT) return null;
  return { key: e.EASEBUZZ_KEY, salt: e.EASEBUZZ_SALT, env: e.EASEBUZZ_ENV, ...HOSTS[e.EASEBUZZ_ENV] };
}

function requireConfig(cfg?: GatewayConfig): GatewayConfig {
  const c = cfg ?? gatewayConfig();
  if (!c) throw new AppError("GATEWAY_UNAVAILABLE", "Online payments are not available right now.");
  return c;
}

export const sha512 = (s: string) => createHash("sha512").update(s).digest("hex");

/** Paise -> "100.00", the format Easebuzz expects and hashes. */
export const amountString = (paise: number) => (paise / 100).toFixed(2);

/** "100", "100.5", "100.50" -> paise. Anything else (or more than 2 decimals) -> null. */
export function paiseFromAmountString(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!/^[0-9]{1,10}(\.[0-9]{1,2})?$/.test(s)) return null;
  const [r, p = ""] = s.split(".");
  return Number(r) * 100 + Number(p.padEnd(2, "0"));
}

export interface InitiateParams {
  txnid: string;
  amount: string; // "100.00"
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  surl: string;
  furl: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  udf6?: string;
  udf7?: string;
  udf8?: string;
  udf9?: string;
  udf10?: string;
}

const UDF = ["udf1", "udf2", "udf3", "udf4", "udf5", "udf6", "udf7", "udf8", "udf9", "udf10"] as const;

/** sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf10|salt) */
export function generateInitiateHash(p: Pick<InitiateParams, "txnid" | "amount" | "productinfo" | "firstname" | "email"> & Partial<Record<(typeof UDF)[number], string>>, cfg?: GatewayConfig): string {
  const c = requireConfig(cfg);
  return sha512([c.key, p.txnid, p.amount, p.productinfo, p.firstname, p.email, ...UDF.map((u) => p[u] ?? ""), c.salt].join("|"));
}

/** sha512(salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key) computed from a gateway response. */
export function computeResponseHash(r: Record<string, unknown>, cfg?: GatewayConfig): string {
  const c = requireConfig(cfg);
  const s = (k: string) => (r[k] === undefined || r[k] === null ? "" : String(r[k]));
  const udfDesc = [...UDF].reverse().map((u) => s(u));
  return sha512([c.salt, s("status"), ...udfDesc, s("email"), s("firstname"), s("productinfo"), s("amount"), s("txnid"), c.key].join("|"));
}

/** Timing-safe check of the hash Easebuzz sent back. Never throws on bad input: it just returns false. */
export function verifyResponseHash(r: unknown, cfg?: GatewayConfig): boolean {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  const rec = r as Record<string, unknown>;
  if (typeof rec.hash !== "string" || rec.hash === "") return false;
  return safeEqual(computeResponseHash(rec, cfg), rec.hash.toLowerCase());
}

/** Remove secrets (hash, key, salt, card numbers, tokens) from a gateway payload before storing it. */
export function sanitizeGatewayPayload(r: unknown): Record<string, unknown> | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  return redact(r) as Record<string, unknown>;
}

async function postForm(url: string, body: Record<string, string>, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // Log the error kind only: the request body holds the key and hash.
    console.error(`Easebuzz ${what} request failed:`, err instanceof Error ? err.name : "error");
    throw new AppError("GATEWAY_UNAVAILABLE", "The payment gateway could not be reached. Please try again.");
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error(`Easebuzz ${what} returned a non-JSON response (HTTP ${res.status})`);
    throw new AppError("GATEWAY_UNAVAILABLE", `The payment gateway sent an unexpected response (HTTP ${res.status}, not JSON). Check the Easebuzz environment (EASEBUZZ_ENV) and try again.`);
  }
}

/** Start a hosted checkout. Returns the access key and the URL to send the customer to. */
export async function initiatePayment(p: InitiateParams, cfg?: GatewayConfig): Promise<{ accessKey: string; checkoutUrl: string }> {
  const c = requireConfig(cfg);
  const hash = generateInitiateHash(p, c);
  const body: Record<string, string> = { key: c.key, hash };
  for (const [k, v] of Object.entries(p)) if (v !== undefined) body[k] = String(v);
  const json = (await postForm(`${c.payBase}payment/initiateLink`, body, "initiate")) as { status?: unknown; data?: unknown } | null;
  if (!json || typeof json !== "object" || Number(json.status) !== 1 || typeof json.data !== "string" || !json.data) {
    const why = typeof json?.data === "string" ? json.data.slice(0, 200) : "no reason given";
    throw new AppError("GATEWAY_UNAVAILABLE", `The payment gateway did not accept the payment (${why}).`);
  }
  return { accessKey: json.data, checkoutUrl: `${c.payBase}pay/${json.data}` };
}

export type GatewayState = "success" | "failed" | "pending";

export interface GatewayTxn {
  txnid: string;
  state: GatewayState;
  amount: string | null;
  easebuzzId: string | null;
  mode: string | null;
  message: string | null;
  raw: Record<string, unknown>;
}

export function mapGatewayState(s: unknown): GatewayState | null {
  const v = String(s ?? "").trim().toLowerCase();
  if (v === "success") return "success";
  if (["failure", "failed", "usercancelled", "user cancelled", "cancelled", "canceled", "dropped", "bounced", "rejected"].includes(v)) return "failed";
  if (["pending", "initiated", "in progress", "inprogress", "auth_pending", "queued"].includes(v)) return "pending";
  return null;
}

/** Read a transaction out of a retrieve response, which may carry it as `msg` or `data`, as an object or a one-item list. */
export function parseRetrieveResponse(json: unknown): GatewayTxn | null {
  if (!json || typeof json !== "object") return null;
  const top = json as Record<string, unknown>;
  let cand: unknown = top.msg ?? top.data ?? null;
  if (Array.isArray(cand)) cand = cand[0];
  if (!cand || typeof cand !== "object") {
    if (typeof top.txnid === "string") cand = top;
    else return null;
  }
  const t = cand as Record<string, unknown>;
  if (typeof t.txnid !== "string") return null;
  const state = mapGatewayState(t.status);
  if (!state) return null;
  const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
  return {
    txnid: t.txnid,
    state,
    amount: str(t.amount),
    easebuzzId: str(t.easepayid ?? t.easebuzz_id),
    mode: str(t.mode ?? t.payment_mode),
    message: str(t.error_Message ?? t.error_message ?? t.error),
    raw: sanitizeGatewayPayload(t) ?? {},
  };
}

/** Ask Easebuzz what happened to a transaction. Returns null when the answer cannot be understood. */
export async function retrieveTransaction(txnid: string, cfg?: GatewayConfig): Promise<GatewayTxn | null> {
  const c = requireConfig(cfg);
  const hash = sha512([c.key, txnid, c.salt].join("|"));
  const json = await postForm(`${c.dashBase}transaction/v1/retrieve`, { key: c.key, txnid, hash }, "retrieve");
  return parseRetrieveResponse(json);
}

export interface RefundResult {
  accepted: boolean;
  gatewayRefundId: string | null;
  message: string | null;
  raw: Record<string, unknown>;
}

/** hash = sha512(key|merchant_refund_id|easebuzz_id|refund_amount|salt) */
export function generateRefundHash(merchantRefundId: string, easebuzzId: string, refundAmount: string, cfg?: GatewayConfig): string {
  const c = requireConfig(cfg);
  return sha512([c.key, merchantRefundId, easebuzzId, refundAmount, c.salt].join("|"));
}

/** Request a refund. Throws GATEWAY_UNAVAILABLE for network problems and non-JSON answers (outcome unknown). */
export async function requestRefund(p: { easebuzzId: string; amountPaise: number; merchantRefundId: string }, cfg?: GatewayConfig): Promise<RefundResult> {
  const c = requireConfig(cfg);
  const refundAmount = amountString(p.amountPaise);
  const hash = generateRefundHash(p.merchantRefundId, p.easebuzzId, refundAmount, c);
  const json = await postForm(
    `${c.dashBase}transaction/v2/refund`,
    { key: c.key, easebuzz_id: p.easebuzzId, refund_amount: refundAmount, merchant_refund_id: p.merchantRefundId, hash },
    "refund",
  );
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new AppError("GATEWAY_UNAVAILABLE", "The payment gateway sent an unexpected refund response (not JSON). The refund stays queued; check the Easebuzz environment and try again.");
  }
  const r = json as Record<string, unknown>;
  const ok = r.status === true || r.status === 1 || r.status === "1" || String(r.status).toLowerCase() === "success";
  const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
  const message = str(r.reason ?? r.message ?? r.msg ?? r.error_message);
  return {
    accepted: ok,
    gatewayRefundId: str(r.refund_id ?? r.arn_number),
    message: message ? message.slice(0, 300) : null,
    raw: sanitizeGatewayPayload(r) ?? {},
  };
}
