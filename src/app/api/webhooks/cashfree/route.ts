import { route } from "@/server/api";
import { handleWebhook } from "../_handler";

/** Platform-level cashfree webhook (uses the platform webhook secret from the environment). */
export const POST = route(async (req, ctx) => handleWebhook(req, ctx, "CASHFREE", null), { public: true, csrf: false });
