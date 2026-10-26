import { route } from "@/server/api";
import { handleWebhook } from "../../_handler";

/** Per-business razorpay webhook: verified with that business's stored (encrypted) webhook secret. */
export const POST = route<{ configId: string }>(async (req, ctx, { configId }) => handleWebhook(req, ctx, "RAZORPAY", configId), { public: true, csrf: false });
