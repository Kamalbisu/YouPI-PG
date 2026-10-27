import { AppShell, type NavItem } from "@/components/layout/app-shell";
import { requireAdminPage } from "@/server/auth/page-guards";

export const dynamic = "force-dynamic";

const NAV: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: "dashboard", exact: true },
  { href: "/admin/users", label: "Users", icon: "users" },
  { href: "/admin/payments", label: "Payments", icon: "payments" },
  { href: "/admin/transactions", label: "Transactions", icon: "transactions" },
  { href: "/admin/qr", label: "QR codes", icon: "qr" },
  { href: "/admin/notifications", label: "Notifications", icon: "notifications" },
  { href: "/admin/gateway", label: "Gateway", icon: "payments" },
  { href: "/admin/auditors", label: "Admin 2 accounts", icon: "auditors" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireAdminPage();
  return (
    <AppShell portal="admin" brand="YouPI PG" badge="Admin" nav={NAV} user={{ name: actor.name, username: actor.username }}>
      {children}
    </AppShell>
  );
}
