import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { createQr, listQrsAdmin, readQrForm } from "@/server/services/qr";

export const GET = route(async (_req, ctx) => {
  requireAdmin(ctx);
  return listQrsAdmin();
});

export const POST = route(async (req, ctx) => {
  requireAdmin(ctx);
  const { fields, file } = await readQrForm(req);
  return createQr(ctx, fields, file);
});
