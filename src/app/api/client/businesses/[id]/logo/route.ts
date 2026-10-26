import { badRequest } from "@/lib/errors";
import { route } from "@/server/api";
import { removeBusinessLogo, setBusinessLogo } from "@/server/services/businesses";

type P = { id: string };

export const POST = route<P>(async (req, ctx, { id }) => {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) throw badRequest("Send the logo as multipart/form-data");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Choose an image file", { fields: { file: "Choose an image file" } });
  return setBusinessLogo(ctx, id, file);
});

export const DELETE = route<P>(async (_req, ctx, { id }) => removeBusinessLogo(ctx, id));
