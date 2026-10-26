import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export const MAX_IMAGE_BYTES = 1024 * 1024;
export type ImageType = "image/png" | "image/jpeg" | "image/webp";

/** Identify an image by its leading bytes. The client-supplied content type is never trusted. */
export function sniffImageType(buf: Uint8Array): ImageType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Validates (size, magic bytes) and stores an uploaded image as a FileAsset.
 * Callers are responsible for authorization before calling this.
 */
export async function saveImageAsset(file: File, createdById: string): Promise<{ id: string }> {
  if (!file || typeof file.arrayBuffer !== "function") throw new AppError("VALIDATION", "Choose an image file", { fields: { file: "Choose an image file" } });
  if (file.size === 0) throw new AppError("VALIDATION", "The file is empty", { fields: { file: "The file is empty" } });
  if (file.size > MAX_IMAGE_BYTES) throw new AppError("VALIDATION", "Image must be 1 MB or smaller", { fields: { file: "Image must be 1 MB or smaller" } });
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) throw new AppError("VALIDATION", "Image must be 1 MB or smaller", { fields: { file: "Image must be 1 MB or smaller" } });
  const type = sniffImageType(data);
  if (!type) throw new AppError("VALIDATION", "Only PNG, JPEG or WebP images are allowed", { fields: { file: "Only PNG, JPEG or WebP images are allowed" } });
  const row = await db.fileAsset.create({
    data: { contentType: type, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data, createdById },
    select: { id: true },
  });
  return { id: row.id };
}
