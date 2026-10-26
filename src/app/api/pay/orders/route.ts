import { route, jsonBody } from "@/server/api";
import { createOrder } from "@/server/services/orders";

/** Public: create an order from a QR scan. Prices are computed server side; the client sends only ids and quantities. */
export const POST = route(async (req, ctx) => createOrder(ctx, await jsonBody(req)), { public: true });
