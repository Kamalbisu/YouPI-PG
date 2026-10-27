import { route } from "@/server/api";
import { retryRefund } from "@/server/services/refunds";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => retryRefund(ctx, id));
