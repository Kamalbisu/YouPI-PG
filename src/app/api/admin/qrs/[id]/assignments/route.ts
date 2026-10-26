import { jsonBody, route } from "@/server/api";
import { parse } from "@/lib/validation";
import { AssignInput, assignQr, unassignQr } from "@/server/services/qr";

type P = { id: string };
export const POST = route<P>(async (req, ctx, { id }) => assignQr(ctx, id, parse(AssignInput, await jsonBody(req))));
export const DELETE = route<P>(async (req, ctx, { id }) => unassignQr(ctx, id, parse(AssignInput, await jsonBody(req))));
