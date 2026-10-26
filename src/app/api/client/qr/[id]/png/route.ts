import { route } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { getQrForDownload } from "@/server/services/qr";
import { renderQrPng } from "@/server/services/qr-render";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireClient(ctx);
  const q = await getQrForDownload(ctx, { id });
  const png = await renderQrPng(q.token);
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="qr-${q.id}.png"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
