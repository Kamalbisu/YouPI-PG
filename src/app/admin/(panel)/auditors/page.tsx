import type { Metadata } from "next";
import { Card, CardHeader, DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { AuditorForm } from "@/components/admin/auditor-form";
import { fmtDate } from "@/components/shared/dates";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listAuditors } from "@/server/services/auditors";

export const metadata: Metadata = { title: "Admin 2 accounts" };

export default async function AuditorsPage() {
  const { ctx } = await requireAdminPage();
  const rows = await listAuditors(ctx);
  return (
    <>
      <PageHeader title="Admin 2 accounts" description="Read-only auditors. They sign in at /auditor/login." />
      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <Card className="overflow-hidden">
          <CardHeader title="Accounts" />
          <DataTable
            rows={rows}
            rowKey={(a) => a.id}
            empty={{ title: "No Admin 2 yet", description: "Create one with the form." }}
            columns={[
              { key: "n", header: "Name", cell: (a) => <span>{a.name} <span className="text-ink-muted">@{a.username}</span></span> },
              { key: "e", header: "Email", cell: (a) => a.email ?? "-" },
              { key: "s", header: "Status", cell: (a) => <StatusBadge status={a.status} /> },
              { key: "l", header: "Last login", cell: (a) => fmtDate(a.lastLoginAt) },
            ]}
          />
        </Card>
        <AuditorForm />
      </div>
    </>
  );
}
