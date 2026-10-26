import { AppShell, type NavItem } from "@/components/layout/app-shell";
import { requireAdminPage } from "@/server/auth/page-guards";

export const dynamic = "force-dynamic";

const NAV: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: "dashboard", exact: true },
  { href: "/admin/clients", label: "Clients", icon: "clients" },
  { href: "/admin/businesses", label: "Businesses", icon: "businesses" },
  { href: "/admin/products", label: "Products", icon: "products" },
  { href: "/admin/qr", label: "QR Management", icon: "qr" },
  { href: "/admin/transactions", label: "Transactions", icon: "transactions" },
  { href: "/admin/payments", label: "Payment Configuration", icon: "payments" },
  { href: "/admin/reports", label: "Reports", icon: "reports" },
  { href: "/admin/audit-logs", label: "Audit Logs", icon: "audit" },
  { href: "/admin/support", label: "Support", icon: "support" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireAdminPage();
  return (
    <AppShell portal="admin" brand="YouPI PG" badge="Super Admin" nav={NAV} user={{ name: actor.name, email: actor.email }}>
      {children}
    </AppShell>
  );
}
