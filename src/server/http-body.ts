import type { NextRequest } from "next/server";
import { jsonBody } from "./api";

/** Read a gateway callback body: form-encoded (what Easebuzz posts) or JSON. Values are strings only for forms. */
export async function gatewayBody(req: NextRequest): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = await jsonBody(req);
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  }
  try {
    const text = await req.text();
    if (text.length > 256 * 1024) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
