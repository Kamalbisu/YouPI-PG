import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import type { Actor, Ctx } from "@/server/auth/types";
import { catalogActor } from "./categories";

export const MAX_PRODUCT_IMAGE_BYTES = 1024 * 1024;
export type ProductImageType = "image/png" | "image/jpeg" | "image/webp";

/** Identify an image by its leading bytes. A client-supplied content type is never trusted. */
export function detectImageType(buf: Uint8Array): ProductImageType | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const fail = (msg: string) => new AppError("VALIDATION", msg, { fields: { file: msg } });

/**
 * Validates (size, magic bytes) and stores an uploaded image as a FileAsset.
 * The caller must have authorized the actor first.
 */
export async function saveProductImage(actor: Pick<Actor, "userId"> | null, bytes: Uint8Array | Buffer): Promise<{ id: string; contentType: ProductImageType; size: number }> {
  if (!bytes || bytes.length === 0) throw fail("The file is empty");
  if (bytes.length > MAX_PRODUCT_IMAGE_BYTES) throw fail("Image must be 1 MB or smaller");
  const contentType = detectImageType(bytes);
  if (!contentType) throw fail("Only PNG, JPEG or WebP images are allowed");
  const data = Buffer.from(bytes);
  const row = await db.fileAsset.create({
    data: { contentType, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data, createdById: actor?.userId ?? null },
    select: { id: true },
  });
  return { id: row.id, contentType, size: data.length };
}

export async function getFile(id: string) {
  if (!id || id.length > 64) throw notFound("File");
  const f = await db.fileAsset.findUnique({ where: { id }, select: { id: true, contentType: true, size: true, sha256: true, data: true } });
  if (!f) throw notFound("File");
  return f;
}

/** Build the response for a stored file. Hardened: no sniffing, no active content. */
export function fileResponse(f: { contentType: string; sha256: string; data: Uint8Array }, ifNoneMatch?: string | null): Response {
  const etag = `"${f.sha256}"`;
  const headers: Record<string, string> = {
    "Content-Type": f.contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  };
  if (ifNoneMatch && ifNoneMatch.split(",").map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers["Content-Length"] = String(f.data.length);
  return new Response(new Uint8Array(f.data), { status: 200, headers });
}

/**
 * Authorized upload entry point for the product image routes: products.manage (or admin),
 * size checked before the bytes are read, magic bytes verified, upload audited.
 */
export async function uploadProductImage(ctx: Ctx, file: { size: number; arrayBuffer(): Promise<ArrayBuffer> }) {
  const actor = catalogActor(ctx, "products.manage");
  if (file.size > MAX_PRODUCT_IMAGE_BYTES) throw fail("Image must be 1 MB or smaller");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const saved = await saveProductImage(actor, bytes);
  await audit(ctx, { action: "file.upload", entityType: "FileAsset", entityId: saved.id, metadata: { contentType: saved.contentType, size: saved.size, purpose: "product-image" } });
  return { ...saved, url: `/api/files/${saved.id}` };
}
