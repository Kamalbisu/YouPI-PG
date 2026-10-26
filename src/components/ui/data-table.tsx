import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, EmptyState } from "./card";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  className?: string;
}

/** Server-rendered table. Pair with <FilterBar/> and <Pagination/>; state lives in the URL. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  empty?: { title: string; description?: string; action?: ReactNode };
}) {
  if (rows.length === 0) {
    return <EmptyState title={empty?.title ?? "Nothing here yet"} description={empty?.description} action={empty?.action} />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn("px-4 py-3", c.align === "right" && "text-right", c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={rowKey(r)} className="hover:bg-surface-muted/60">
              {columns.map((c) => (
                <td key={c.key} className={cn("px-4 py-3 align-middle", c.align === "right" && "text-right tabular-nums", c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableCard({ children }: { children: ReactNode }) {
  return <Card className="overflow-hidden">{children}</Card>;
}

function hrefWith(base: string, params: Record<string, string | undefined>, page: number) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

export function Pagination({
  base,
  params,
  page,
  pageSize,
  total,
}: {
  base: string;
  params: Record<string, string | undefined>;
  page: number;
  pageSize: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn = "inline-flex size-8 items-center justify-center rounded-lg border border-line";
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-ink-muted">
      <span>
        {from}-{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline">
          Page {page} of {pages}
        </span>
        {page > 1 ? (
          <Link aria-label="Previous page" href={hrefWith(base, params, page - 1)} className={cn(btn, "hover:bg-surface-muted")}>
            <ChevronLeft className="size-4" />
          </Link>
        ) : (
          <span aria-hidden className={cn(btn, "opacity-40")}>
            <ChevronLeft className="size-4" />
          </span>
        )}
        {page < pages ? (
          <Link aria-label="Next page" href={hrefWith(base, params, page + 1)} className={cn(btn, "hover:bg-surface-muted")}>
            <ChevronRight className="size-4" />
          </Link>
        ) : (
          <span aria-hidden className={cn(btn, "opacity-40")}>
            <ChevronRight className="size-4" />
          </span>
        )}
      </div>
    </nav>
  );
}
