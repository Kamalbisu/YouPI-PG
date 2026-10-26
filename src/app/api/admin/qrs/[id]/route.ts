import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { deleteQr, readQrForm, updateQr } from "@/server/services/qr";

type P = { id: string };

export const PATCH = route<P>(async (req, ctx, { id }) => {
  requireAdmin(ctx);
  const { fields, file } = await readQrForm(req);
  return updateQr(ctx, id, fields, file);
});

export const DELETE = route<P>(async (_req, ctx, { id }) => deleteQr(ctx, id));
