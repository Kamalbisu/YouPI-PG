import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { Card, Skeleton } from "@/components/ui";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Flattens Next search params to single strings. */
export async function flatParams(sp: SearchParams): Promise<Record<string, string | undefined>> {
  const raw = await sp;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
}

/** Runs a service call for a page: NOT_FOUND becomes a 404 page, other failures become an inline message. */
export async function load<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    if (e instanceof AppError && e.code !== "INTERNAL") return { ok: false, error: e.message };
    return { ok: false, error: "Could not load this page. Please try again." };
  }
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="mb-6 space-y-2"><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-72" /></div>
      <Card className="overflow-hidden">
        <div className="border-b border-line p-4"><Skeleton className="h-9 w-full max-w-md" /></div>
        <div className="space-y-3 p-4">
          {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-8" />)}
        </div>
      </Card>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-5">
      <div className="space-y-2"><Skeleton className="h-8 w-64" /><Skeleton className="h-4 w-40" /></div>
      <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      <Skeleton className="h-64" />
    </div>
  );
}
