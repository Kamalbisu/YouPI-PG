import { route } from "@/server/api";
import { getPublicOrder } from "@/server/services/orders";

export const GET = route<{ publicId: string }>(async (_req, _ctx, { publicId }) => getPublicOrder(publicId), { public: true });
