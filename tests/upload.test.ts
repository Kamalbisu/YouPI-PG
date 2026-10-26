import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { MAX_IMAGE_BYTES, imageResponse, saveImageAsset, sniffImageType } from "@/server/services/files";
import { createQr, updateQr } from "@/server/services/qr";
import { PNG_BYTES, ctxFor, makeAdmin, pngFile, resetDb } from "./helpers";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);

let adminId: string;
beforeEach(async () => {
  await resetDb();
  adminId = (await makeAdmin()).id;
});

describe("image detection", () => {
  it("recognises PNG, JPEG and WebP by content", () => {
    expect(sniffImageType(PNG_BYTES)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });
  it("refuses everything else", () => {
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImageType(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(sniffImageType(Buffer.from("GIF89a" + "x".repeat(30)))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // truncated PNG
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe("saveImageAsset", () => {
  it("stores a valid image with the sniffed type, not the claimed one", async () => {
    const { id } = await saveImageAsset(pngFile("qr.jpg", PNG_BYTES, "image/jpeg"), adminId);
    const row = await db.fileAsset.findUnique({ where: { id } });
    expect(row?.contentType).toBe("image/png");
    expect(row?.size).toBe(PNG_BYTES.length);
  });

  it("refuses a script or text file renamed to .png with an image content type", async () => {
    const evil = new File([Buffer.from("<script>alert(1)</script>")], "qr.png", { type: "image/png" });
    await expect(saveImageAsset(evil, adminId)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.fileAsset.count()).toBe(0);
  });

  it("refuses SVG, empty, missing and oversize files", async () => {
    const svg = new File([Buffer.from("<svg onload=alert(1)></svg>")], "x.svg", { type: "image/svg+xml" });
    await expect(saveImageAsset(svg, adminId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveImageAsset(new File([], "e.png", { type: "image/png" }), adminId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveImageAsset(null, adminId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveImageAsset("not a file", adminId)).rejects.toMatchObject({ code: "VALIDATION" });
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_IMAGE_BYTES)]);
    await expect(saveImageAsset(pngFile("big.png", big), adminId)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.fileAsset.count()).toBe(0);
  });

  it("serves images hardened and supports ETag revalidation", async () => {
    const { id } = await saveImageAsset(pngFile(), adminId);
    const row = (await db.fileAsset.findUnique({ where: { id } }))!;
    const res = imageResponse(row);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(imageResponse(row, res.headers.get("etag")).status).toBe(304);
  });
});

describe("QR create and update with uploads", () => {
  it("requires an image and a label", async () => {
    const admin = await ctxFor((await db.user.findFirst({ where: { role: "ADMIN" } }))!);
    await expect(createQr(admin, { label: "No image" }, null)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createQr(admin, { label: "x" }, pngFile())).rejects.toBeTruthy();
    expect(await db.qr.count()).toBe(0);
  });

  it("parses amounts to paise and rejects nonsense", async () => {
    const admin = await ctxFor((await db.user.findFirst({ where: { role: "ADMIN" } }))!);
    const q = await createQr(admin, { label: "Fee", amount: "499.50" }, pngFile());
    expect((await db.qr.findUnique({ where: { id: q.id } }))?.amountPaise).toBe(49950);
    await expect(createQr(admin, { label: "Bad", amount: "abc" }, pngFile())).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("replacing the image removes the old one and rejects a bad replacement", async () => {
    const admin = await ctxFor((await db.user.findFirst({ where: { role: "ADMIN" } }))!);
    const q = await createQr(admin, { label: "Swap" }, pngFile());
    const before = (await db.qr.findUnique({ where: { id: q.id } }))!.imageId;
    await expect(updateQr(admin, q.id, {}, new File([Buffer.from("nope")], "a.png", { type: "image/png" }))).rejects.toBeTruthy();
    expect((await db.qr.findUnique({ where: { id: q.id } }))!.imageId).toBe(before);
    await updateQr(admin, q.id, { label: "Swapped" }, pngFile("b.png", Buffer.concat([JPEG, Buffer.alloc(30)]), "image/jpeg"));
    const after = (await db.qr.findUnique({ where: { id: q.id } }))!;
    expect(after.imageId).not.toBe(before);
    expect(after.label).toBe("Swapped");
    expect(await db.fileAsset.findUnique({ where: { id: before } })).toBeNull();
  });
});
