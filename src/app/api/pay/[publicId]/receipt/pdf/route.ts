import { route } from "@/server/api";
import { receiptPdf } from "@/server/services/receipts";

export const GET = route<{ publicId: string }>(
  async (_req, _ctx, { publicId }) => {
    const { filename, pdf } = await receiptPdf(publicId);
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" },
    });
  },
  { public: true },
);
