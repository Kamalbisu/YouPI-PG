import Link from "next/link";
import { DataTable, ErrorState, PageHeader, Pagination, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { MetadataCell } from "@/components/features/settings/metadata-cell";
import { formatDateTime } from "@/lib/utils";
import { requireAdminPage } from "@/server/auth/page-guards";
import { auditFilterOptions, listAuditLogs } from "@/server/services/audit-logs";

export const metadata = { title: "Audit log" };

export default async function AuditLogsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  const sp = await flatParams(searchParams);
  const res = await load(async () => ({ page: await listAuditLogs(ctx, sp), options: await auditFilterOptions(ctx) }));
  const keys = ["q", "action", "entityType", "clientId", "actor", "from", "to"] as const;
  const filtered = keys.some((k) => sp[k]);
  return (
    <>
      <PageHeader title="Audit log" description="Every change made by admins and clients, newest first." />
      <TableCard>
        <FilterBar
          exportHref="/api/admin/audit-logs/export"
          filters={[
            { name: "q", label: "Search", type: "search", placeholder: "Action, actor or entity id" },
            { name: "action", label: "Action", type: "select", options: (res.ok ? res.data.options.actions : []).map((a) => ({ value: a, label: a })) },
            { name: "entityType", label: "Entity", type: "select", options: (res.ok ? res.data.options.entityTypes : []).map((a) => ({ value: a, label: a })) },
            { name: "clientId", label: "Client id", type: "search", placeholder: "Client id" },
            { name: "actor", label: "Actor", type: "search", placeholder: "Email or user id" },
            { name: "from", label: "From", type: "date" },
            { name: "to", label: "To", type: "date" },
          ]}
        />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.page.items}
              rowKey={(r) => r.id}
              empty={{ title: "No audit entries", description: filtered ? "Try changing or clearing the filters." : "Entries appear as soon as something changes." }}
              columns={[
                { key: "t", header: "Time", cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.createdAt)}</span> },
                { key: "a", header: "Actor", cell: (r) => (<div><p>{r.actorEmail ?? "System"}</p><p className="text-xs text-ink-muted">{r.actorRole ?? ""}</p></div>) },
                { key: "ac", header: "Action", cell: (r) => <code className="text-xs">{r.action}</code> },
                { key: "e", header: "Entity", cell: (r) => (<div><p>{r.entityType}</p><p className="max-w-[10rem] truncate text-xs text-ink-muted" title={r.entityId ?? ""}>{r.entityId}</p></div>) },
                { key: "c", header: "Client", cell: (r) => (r.clientId ? <Link className="text-brand-600 hover:underline" href={`/admin/clients/${r.clientId}`}>Open</Link> : "") },
                { key: "m", header: "Details", cell: (r) => <MetadataCell value={r.metadata} /> },
              ]}
            />
            <Pagination base="/admin/audit-logs" params={Object.fromEntries(keys.map((k) => [k, sp[k]]))} page={res.data.page.page} pageSize={res.data.page.pageSize} total={res.data.page.total} />
          </>
        )}
      </TableCard>
    </>
  );
}
