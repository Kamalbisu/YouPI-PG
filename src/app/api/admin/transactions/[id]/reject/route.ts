import { jsonBody, route } from "@/server/api";
import { rejectTransaction } from "@/server/services/transactions";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => rejectTransaction(ctx, id, await jsonBody(req)));
