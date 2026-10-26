import { route } from "@/server/api";
import { handleWebhook } from "../_handler";

/** Dev simulator webhook. ingestWebhook answers 404 unless the simulator is enabled (never in production). */
export const POST = route(async (req, ctx) => handleWebhook(req, ctx, "DEV_SIMULATOR", null), { public: true, csrf: false });
