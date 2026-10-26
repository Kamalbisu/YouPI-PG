"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Button, FilterInput, FilterSelect } from "@/components/ui";

export interface FilterDef {
  name: string;
  label: string;
  type: "search" | "select" | "date";
  options?: { value: string; label: string }[];
  placeholder?: string;
}

/** URL-driven filter form. Submitting resets to page 1. */
export function FilterBar({ filters, exportHref }: { filters: FilterDef[]; exportHref?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(filters.map((f) => [f.name, sp.get(f.name) ?? ""])));

  const apply = (next: Record<string, string>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    start(() => router.push(q.size ? `${pathname}?${q}` : pathname));
  };
  const dirty = Object.values(values).some(Boolean);
  const exportQs = new URLSearchParams(Object.entries(values).filter(([, v]) => v)).toString();

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); apply(values); }}
      className="flex flex-wrap items-end gap-3 border-b border-line p-4"
      role="search"
    >
      {filters.map((f) => (
        <div key={f.name} className="flex min-w-[9rem] flex-col gap-1">
          <label className="text-xs font-medium text-ink-muted" htmlFor={`f-${f.name}`}>{f.label}</label>
          {f.type === "select" ? (
            <FilterSelect id={`f-${f.name}`} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
              <option value="">All</option>
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </FilterSelect>
          ) : (
            <FilterInput
              id={`f-${f.name}`}
              type={f.type === "date" ? "date" : "search"}
              placeholder={f.placeholder}
              value={values[f.name]}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          )}
        </div>
      ))}
      <Button type="submit" size="sm" className="h-9" loading={pending}><Search className="size-4" />Apply</Button>
      {dirty && (
        <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => { setValues(Object.fromEntries(filters.map((f) => [f.name, ""]))); apply({}); }}>
          <X className="size-4" />Clear
        </Button>
      )}
      {exportHref && (
        <a href={`${exportHref}${exportQs ? (exportHref.includes("?") ? "&" : "?") + exportQs : ""}`} className="ml-auto inline-flex h-9 items-center rounded-lg border border-line px-3 text-sm font-medium hover:bg-surface-muted">
          Export CSV
        </a>
      )}
    </form>
  );
}
