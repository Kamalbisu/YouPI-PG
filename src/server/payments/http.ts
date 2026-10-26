import { AppError } from "@/lib/errors";
import type { FetchImpl } from "./types";

const TIMEOUT_MS = 15_000;

export interface HttpResult {
  status: number;
  json: Record<string, unknown> | unknown[] | null;
}

/** Provider HTTP with a timeout. Secrets are passed only in headers and never appear in thrown messages. */
export async function providerRequest(
  fetchImpl: FetchImpl,
  provider: string,
  req: { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<HttpResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: { "content-type": "application/json", accept: "application/json", ...req.headers },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json: HttpResult["json"] = null;
    try {
      json = text ? (JSON.parse(text) as HttpResult["json"]) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (e) {
    const aborted = (e as { name?: string }).name === "AbortError";
    throw new AppError("PROVIDER_UNAVAILABLE", aborted ? `${provider} did not respond in time. Please try again.` : `${provider} is unreachable. Please try again.`);
  } finally {
    clearTimeout(timer);
  }
}

/** Maps a non-2xx provider answer to an AppError without echoing raw bodies. */
export function providerError(provider: string, status: number, description?: unknown): AppError {
  const desc = typeof description === "string" ? description.slice(0, 200) : undefined;
  if (status === 401 || status === 403) return new AppError("PAYMENT_ERROR", `${provider} rejected the credentials`, { status });
  if (status === 429 || status >= 500) return new AppError("PROVIDER_UNAVAILABLE", `${provider} is temporarily unavailable. Please try again.`, { status });
  return new AppError("PAYMENT_ERROR", desc ? `${provider}: ${desc}` : `${provider} could not process the request`, { status });
}

export const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
export const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
