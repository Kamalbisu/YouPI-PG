import { notFound } from "@/lib/errors";
import { route, searchParams } from "@/server/api";
import { userTimeline } from "@/server/services/activity";

export const GET = route<{ id: string }>(async (req, ctx, { id }) => {
  const r = await userTimeline(ctx, id, searchParams(req));
  if (!r) throw notFound("User");
  return r;
});
