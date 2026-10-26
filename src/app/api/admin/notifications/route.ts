import { jsonBody, route, searchParams } from "@/server/api";
import { listNotificationsAdmin, sendNotification } from "@/server/services/notifications";

export const GET = route(async (req, ctx) => listNotificationsAdmin(ctx, searchParams(req)));
export const POST = route(async (req, ctx) => sendNotification(ctx, await jsonBody(req)));
