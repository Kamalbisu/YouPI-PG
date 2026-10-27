import { NextRequest } from "next/server";
import { vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { APP } from "./helpers";
import { computeResponseHash, type GatewayConfig } from "@/server/gateway/easebuzz";

/** Fake credentials. Nothing here is a real key, and no test calls the real gateway. */
export const KEY = "TESTKEY";
export const SALT = "TESTSALT";
export const WEBHOOK_TOKEN = "hook-token-for-tests-1234";
export const CFG: GatewayConfig = { key: KEY, salt: SALT, env: "test", payBase: "https://testpay.easebuzz.in/", dashBase: "https://testdashboard.easebuzz.in/" };

const KEYS = ["EASEBUZZ_KEY", "EASEBUZZ_SALT", "EASEBUZZ_ENV", "EASEBUZZ_WEBHOOK_TOKEN", "EASEBUZZ_WEBHOOK_HASH"] as const;

export function configureGateway(over: Partial<Record<(typeof KEYS)[number], string | undefined>> = {}) {
  const v: Record<string, string | undefined> = { EASEBUZZ_KEY: KEY, EASEBUZZ_SALT: SALT, EASEBUZZ_ENV: "test", EASEBUZZ_WEBHOOK_TOKEN: WEBHOOK_TOKEN, EASEBUZZ_WEBHOOK_HASH: "refund", ...over };
  for (const k of KEYS) {
    if (v[k] === undefined) delete process.env[k];
    else process.env[k] = v[k];
  }
  resetEnvCache();
}

export function clearGateway() {
  for (const k of KEYS) delete process.env[k];
  resetEnvCache();
}

export type FetchCall = { url: string; body: URLSearchParams };

/** Replace global fetch with a scripted fake. Each reply is a JSON value, a raw string, or an Error to throw. */
export function mockFetch(replies: Array<unknown | string | Error>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (r instanceof Error) throw r;
    const text = typeof r === "string" ? r : JSON.stringify(r);
    return new Response(text, { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

/** What Easebuzz posts back to surl/furl, with a valid hash unless told otherwise. */
export function gatewayPayload(p: { txnid: string; amount: string; status?: string; udf1?: string; easepayid?: string; hash?: string; extra?: Record<string, string> }) {
  const body: Record<string, string> = {
    status: p.status ?? "success",
    txnid: p.txnid,
    amount: p.amount,
    productinfo: "Fees",
    firstname: "Asha",
    email: "asha@example.com",
    udf1: p.udf1 ?? "",
    easepayid: p.easepayid ?? "EZ-1001",
    mode: "UPI",
    card_no: "1234XXXXXXXX9999",
    ...p.extra,
  };
  body.hash = p.hash ?? computeResponseHash(body, CFG);
  return body;
}

export function formReq(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new NextRequest(`${APP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}
