import { route } from "@/server/api";
import { handleWebhook } from "../_handler";

/** Platform-level razorpay webhook (uses the platform webhook secret from the environment). */
export const POST = route(async (req, ctx) => handleWebhook(req, ctx, "RAZORPAY", null), { public: true, csrf: false });
