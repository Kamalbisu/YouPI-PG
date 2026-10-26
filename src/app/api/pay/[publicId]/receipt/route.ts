import { route } from "@/server/api";
import { receiptData } from "@/server/services/receipts";

export const GET = route<{ publicId: string }>(async (_req, _ctx, { publicId }) => receiptData(publicId), { public: true });
