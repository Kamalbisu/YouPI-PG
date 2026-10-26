import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export type ImageType = "image/png" | "image/jpeg" | "image/webp";

/** Identify an image by its leading bytes. A client-supplied content type is never trusted. */
export function sniffImageType(buf: Uint8Array): ImageType | null {
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a &&
    buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52 // IHDR chunk
  ) {
    return "image/png";
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 16 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  ) {
    return "image/webp";
  }
  return null;
}

const fail = (msg: string) => new AppError("VALIDATION", msg, { fields: { file: msg } });

/** Validates size and real image content, then stores the bytes. Caller must have authorized the actor. */
export async function saveImageAsset(file: unknown, createdById: string): Promise<{ id: string }> {
  const f = file as File | null;
  if (!f || typeof f === "string" || typeof f.arrayBuffer !== "function") throw fail("Choose an image file");
  if (f.size === 0) throw fail("The file is empty");
  if (f.size > MAX_IMAGE_BYTES) throw fail("Image must be 2 MB or smaller");
  const data = Buffer.from(await f.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) throw fail("Image must be 2 MB or smaller");
  const type = sniffImageType(data);
  if (!type) throw fail("Only PNG, JPEG or WebP images are allowed");
  const row = await db.fileAsset.create({
    data: { contentType: type, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data, createdById },
    select: { id: true },
  });
  return { id: row.id };
}

/** Response for a stored image. Private (access is checked per request) and hardened against sniffing. */
export function imageResponse(f: { contentType: string; sha256: string; data: Uint8Array }, ifNoneMatch?: string | null): Response {
  const etag = `"${f.sha256}"`;
  const headers: Record<string, string> = {
    "Content-Type": f.contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "private, no-cache",
    ETag: etag,
  };
  if (ifNoneMatch && ifNoneMatch.split(",").map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers["Content-Length"] = String(f.data.length);
  return new Response(new Uint8Array(f.data), { status: 200, headers });
}
