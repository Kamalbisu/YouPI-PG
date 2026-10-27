import { AppShell, type NavItem } from "@/components/layout/app-shell";
import { requireAuditorPage } from "@/server/auth/page-guards";

export const dynamic = "force-dynamic";

const NAV: NavItem[] = [{ href: "/auditor", label: "Activity", icon: "activity", exact: true }];

export default async function AuditorLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireAuditorPage();
  return (
    <AppShell portal="auditor" brand="YouPI PG" badge="Admin 2 (read-only)" nav={NAV} user={{ name: actor.name, username: actor.username }}>
      {children}
    </AppShell>
  );
}
