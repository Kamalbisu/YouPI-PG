import Link from "next/link";
import { Badge, DataTable, ErrorState, PageHeader, Pagination, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { TicketPriorityBadge, TicketStatusBadge } from "@/components/features/support/ticket-badges";
import { formatDateTime } from "@/lib/utils";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listAllTickets } from "@/server/services/support";

export const metadata = { title: "Support" };

export default async function AdminSupportPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  const sp = await flatParams(searchParams);
  const res = await load(() => listAllTickets(ctx, sp));
  const filtered = Boolean(sp.q || sp.status || sp.priority);
  return (
    <>
      <PageHeader title="Support" description="Tickets raised by clients." />
      <TableCard>
        <FilterBar
          filters={[
            { name: "q", label: "Search", type: "search", placeholder: "Subject or ticket code" },
            { name: "status", label: "Status", type: "select", options: [
              { value: "OPEN", label: "Open" }, { value: "IN_PROGRESS", label: "In progress" }, { value: "RESOLVED", label: "Resolved" }, { value: "CLOSED", label: "Closed" },
            ] },
            { name: "priority", label: "Priority", type: "select", options: [{ value: "HIGH", label: "High" }, { value: "NORMAL", label: "Normal" }, { value: "LOW", label: "Low" }] },
          ]}
        />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(t) => t.id}
              empty={{ title: "No tickets found", description: filtered ? "Try changing or clearing the filters." : "Tickets appear here when clients ask for help." }}
              columns={[
                { key: "t", header: "Ticket", cell: (t) => (<div><Link href={`/admin/support/${t.id}`} className="font-medium text-brand-600 hover:underline">{t.subject}</Link><p className="text-xs text-ink-muted">{t.ticketCode}</p></div>) },
                { key: "c", header: "Client", cell: (t) => (<Link href={`/admin/clients/${t.client.id}`} className="hover:underline">{t.client.name}</Link>) },
                { key: "s", header: "Status", cell: (t) => <TicketStatusBadge status={t.status} /> },
                { key: "p", header: "Priority", cell: (t) => <TicketPriorityBadge priority={t.priority} /> },
                { key: "m", header: "Messages", align: "right", cell: (t) => <Badge tone="gray">{t._count.messages}</Badge> },
                { key: "u", header: "Updated", cell: (t) => formatDateTime(t.updatedAt) },
              ]}
            />
            <Pagination base="/admin/support" params={{ q: sp.q, status: sp.status, priority: sp.priority }} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} />
          </>
        )}
      </TableCard>
    </>
  );
}
