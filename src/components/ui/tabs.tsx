import Link from "next/link";
import { cn } from "@/lib/utils";

/** Link-based tabs: state lives in the URL so tabs are shareable and server-rendered. */
export function LinkTabs({ tabs, active }: { tabs: { href: string; label: string; key: string }[]; active: string }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          role="tab"
          aria-selected={t.key === active}
          className={cn(
            "-mb-px border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap",
            t.key === active ? "border-brand-600 text-brand-600" : "border-transparent text-ink-muted hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
