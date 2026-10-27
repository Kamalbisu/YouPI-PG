import { route } from "@/server/api";
import { getPaymentAdmin } from "@/server/services/payments";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => getPaymentAdmin(ctx, id));
