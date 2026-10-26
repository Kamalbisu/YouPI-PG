import { badRequest } from "@/lib/errors";
import { route } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { uploadProductImage } from "@/server/services/files";

export const POST = route(async (req, ctx) => {
  requireClient(ctx);
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) throw badRequest("Send the image as multipart/form-data", { fields: { file: "Choose an image file" } });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Choose an image file", { fields: { file: "Choose an image file" } });
  return uploadProductImage(ctx, file);
});
