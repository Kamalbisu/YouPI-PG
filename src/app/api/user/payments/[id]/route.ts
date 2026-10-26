import { route } from "@/server/api";
import { getPaymentForUser } from "@/server/services/payments";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => getPaymentForUser(ctx, id));
