import { AppShell, type NavItem } from "@/components/layout/app-shell";
import { requireClientPage } from "@/server/auth/page-guards";

export const dynamic = "force-dynamic";

const NAV: NavItem[] = [
  { href: "/client", label: "Dashboard", icon: "dashboard", exact: true },
  { href: "/client/businesses", label: "My Businesses", icon: "businesses" },
  { href: "/client/products", label: "Products and Services", icon: "products" },
  { href: "/client/qr", label: "QR Codes", icon: "qr" },
  { href: "/client/orders", label: "Orders", icon: "orders" },
  { href: "/client/transactions", label: "Transactions", icon: "transactions" },
  { href: "/client/reports", label: "Reports", icon: "reports" },
  { href: "/client/profile", label: "Profile", icon: "profile" },
  { href: "/client/support", label: "Support", icon: "support" },
];

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireClientPage();
  return (
    <AppShell portal="client" brand="YouPI PG" badge="Business" nav={NAV} user={{ name: actor.name, email: actor.email }}>
      {children}
    </AppShell>
  );
}
