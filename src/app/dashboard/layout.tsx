import { AppShell, type NavItem } from "@/components/layout/app-shell";
import { requireUserPage } from "@/server/auth/page-guards";
import { unreadCount } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

export default async function UserLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireUserPage();
  const unread = await unreadCount(actor.userId);
  const nav: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: "dashboard", exact: true, count: unread },
    { href: "/dashboard/payments", label: "Payments", icon: "payments" },
  ];
  return (
    <AppShell portal="user" brand="YouPI PG" badge="My account" nav={nav} user={{ name: actor.name, username: actor.username }}>
      {children}
    </AppShell>
  );
}
