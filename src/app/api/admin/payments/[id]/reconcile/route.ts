import { route } from "@/server/api";
import { reconcilePayment } from "@/server/services/payments";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => reconcilePayment(ctx, id));
