import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/layout/theme-toggle";

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <div className="absolute top-4 right-4"><ThemeToggle /></div>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">Y</div>
          <span className="text-lg font-semibold">YouPI PG</span>
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 mb-5 text-sm text-ink-muted">{subtitle}</p>}
          {!subtitle && <div className="mb-5" />}
          {children}
        </div>
        {footer && <div className="mt-4 text-center text-sm text-ink-muted">{footer}</div>}
      </div>
    </div>
  );
}
