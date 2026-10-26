import { route, jsonBody, searchParams } from "@/server/api";
import { createClient, listClients } from "@/server/services/clients";

export const GET = route(async (req, ctx) => listClients(ctx, searchParams(req)));
export const POST = route(async (req, ctx) => createClient(ctx, await jsonBody(req)));
