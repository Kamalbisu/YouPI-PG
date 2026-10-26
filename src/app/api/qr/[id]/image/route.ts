import { route } from "@/server/api";
import { requireActor } from "@/server/auth/guards";
import { imageResponse } from "@/server/services/files";
import { getQrImageFor } from "@/server/services/qr";

export const GET = route<{ id: string }>(async (req, ctx, { id }) => {
  const img = await getQrImageFor(requireActor(ctx), id);
  return imageResponse(img, req.headers.get("if-none-match"));
});
