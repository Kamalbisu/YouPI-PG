import { route } from "@/server/api";
import { confirmTransaction } from "@/server/services/transactions";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => confirmTransaction(ctx, id));
