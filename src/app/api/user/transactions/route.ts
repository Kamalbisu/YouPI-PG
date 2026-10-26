import { jsonBody, route } from "@/server/api";
import { submitTransaction } from "@/server/services/transactions";

export const POST = route(async (req, ctx) => submitTransaction(ctx, await jsonBody(req)));
