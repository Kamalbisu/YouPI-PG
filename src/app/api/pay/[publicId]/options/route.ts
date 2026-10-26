import { route } from "@/server/api";
import { getPaymentOptions } from "@/server/services/checkout";

export const GET = route<{ publicId: string }>(async (_req, _ctx, { publicId }) => getPaymentOptions(publicId), { public: true });
