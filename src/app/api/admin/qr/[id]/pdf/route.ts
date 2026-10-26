import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { getQrForDownload } from "@/server/services/qr";
import { renderQrPdf } from "@/server/services/qr-render";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  const q = await getQrForDownload(ctx, { id });
  const pdf = await renderQrPdf({
    token: q.token,
    label: q.label,
    businessName: q.business.name,
    fixedAmountMinor: q.fixedAmountMinor,
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="qr-${q.id}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
