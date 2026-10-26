"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Bell, LayoutDashboard, LogOut, Menu, QrCode, Receipt, Users, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { api } from "@/components/shared/use-api";

const ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard, users: Users, qr: QrCode, transactions: Receipt, notifications: Bell,
};

export interface NavItem { href: string; label: string; icon: keyof typeof ICONS | string; exact?: boolean; count?: number }

export function AppShell({
  nav, brand, user, portal, children, badge,
}: {
  nav: NavItem[]; brand: string; user: { name: string; username: string }; portal: "admin" | "user"; children: ReactNode; badge?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [out, setOut] = useState(false);

  const logout = async () => {
    setOut(true);
    try { await api("/api/auth/logout", { method: "POST" }); } finally { router.push(portal === "admin" ? "/admin/login" : "/login"); router.refresh(); }
  };

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 border-b border-line px-5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">Y</div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">{brand}</p>
          {badge && <p className="text-[11px] text-ink-muted">{badge}</p>}
        </div>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {nav.map((n) => {
          const Icon = ICONS[n.icon] ?? LayoutDashboard;
          const active = n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + "/");
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active ? "bg-brand-50 text-brand-700 dark:bg-brand-700/25 dark:text-brand-100" : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
              >
                <Icon className="size-[18px]" />
                <span className="flex-1">{n.label}</span>
                {!!n.count && <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] leading-none font-semibold text-white">{n.count > 99 ? "99+" : n.count}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="no-print sticky top-0 hidden h-screen border-r border-line bg-surface lg:block">{sidebar}</aside>
      {open && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-surface shadow-xl">
            <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute top-4 right-3 rounded p-1 text-ink-muted"><X className="size-5" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:px-8">
          <button aria-label="Open menu" onClick={() => setOpen(true)} className="rounded-lg p-2 text-ink-muted hover:bg-surface-muted lg:hidden"><Menu className="size-5" /></button>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium">{user.name}</p>
              <p className="text-xs text-ink-muted">@{user.username}</p>
            </div>
            <button onClick={logout} disabled={out} className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3 text-sm font-medium hover:bg-surface-muted disabled:opacity-50">
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
