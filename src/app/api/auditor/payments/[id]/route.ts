import { notFound } from "@/lib/errors";
import { route } from "@/server/api";
import { paymentTimeline } from "@/server/services/activity";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  const r = await paymentTimeline(ctx, id);
  if (!r) throw notFound("Payment");
  return r;
});
