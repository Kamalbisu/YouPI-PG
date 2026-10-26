import { route } from "@/server/api";
import { fileResponse, getFile } from "@/server/services/files";

// Files are public by unguessable id (product images, logos).
export const GET = route<{ id: string }>(
  async (req, _ctx, { id }) => fileResponse(await getFile(id), req.headers.get("if-none-match")),
  { public: true },
);
