import Link from "next/link";
import { Plus } from "lucide-react";
import { ButtonLink, DataTable, ErrorState, PageHeader, Pagination, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { TicketPriorityBadge, TicketStatusBadge } from "@/components/features/support/ticket-badges";
import { formatDateTime } from "@/lib/utils";
import { requireClientPage } from "@/server/auth/page-guards";
import { listMyTickets } from "@/server/services/support";

export const metadata = { title: "Support" };

export default async function ClientSupportPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireClientPage();
  const sp = await flatParams(searchParams);
  const res = await load(() => listMyTickets(ctx, sp));
  const filtered = Boolean(sp.q || sp.status);
  return (
    <>
      <PageHeader title="Support" description="Ask us for help and follow your tickets." actions={<ButtonLink href="/client/support/new"><Plus className="size-4" />New ticket</ButtonLink>} />
      <TableCard>
        <FilterBar
          filters={[
            { name: "q", label: "Search", type: "search", placeholder: "Subject or ticket code" },
            { name: "status", label: "Status", type: "select", options: [
              { value: "OPEN", label: "Open" }, { value: "IN_PROGRESS", label: "In progress" }, { value: "RESOLVED", label: "Resolved" }, { value: "CLOSED", label: "Closed" },
            ] },
          ]}
        />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(t) => t.id}
              empty={{ title: "No tickets", description: filtered ? "Try changing or clearing the filters." : "Need help? Create a ticket and we will get back to you.", action: filtered ? undefined : <ButtonLink href="/client/support/new">New ticket</ButtonLink> }}
              columns={[
                { key: "t", header: "Ticket", cell: (t) => (<div><Link href={`/client/support/${t.id}`} className="font-medium text-brand-600 hover:underline">{t.subject}</Link><p className="text-xs text-ink-muted">{t.ticketCode}{t.business ? ` - ${t.business.name}` : ""}</p></div>) },
                { key: "s", header: "Status", cell: (t) => <TicketStatusBadge status={t.status} /> },
                { key: "p", header: "Priority", cell: (t) => <TicketPriorityBadge priority={t.priority} /> },
                { key: "u", header: "Updated", cell: (t) => formatDateTime(t.updatedAt) },
              ]}
            />
            <Pagination base="/client/support" params={{ q: sp.q, status: sp.status }} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} />
          </>
        )}
      </TableCard>
    </>
  );
}
