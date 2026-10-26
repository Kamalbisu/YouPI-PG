import Link from "next/link";
import { DataTable, ErrorState, PageHeader, Pagination, StatusBadge, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { formatDate } from "@/lib/utils";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listBusinesses } from "@/server/services/businesses";

export const metadata = { title: "Businesses" };

export default async function AdminBusinessesPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  const sp = await flatParams(searchParams);
  const res = await load(() => listBusinesses(ctx, sp));
  const filtered = Boolean(sp.q || sp.status);
  return (
    <>
      <PageHeader title="Businesses" description="Review new businesses and manage their status." />
      <TableCard>
        <FilterBar
          filters={[
            { name: "q", label: "Search", type: "search", placeholder: "Business, code or client" },
            { name: "status", label: "Status", type: "select", options: [
              { value: "PENDING_APPROVAL", label: "Pending approval" }, { value: "ACTIVE", label: "Active" }, { value: "SUSPENDED", label: "Suspended" },
              { value: "REJECTED", label: "Rejected" }, { value: "INACTIVE", label: "Inactive" },
            ] },
          ]}
        />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(b) => b.id}
              empty={{ title: "No businesses found", description: filtered ? "Try changing or clearing the filters." : "Businesses appear here once a client creates one." }}
              columns={[
                { key: "name", header: "Business", cell: (b) => (<div><Link href={`/admin/businesses/${b.id}`} className="font-medium text-brand-600 hover:underline">{b.name}</Link><p className="text-xs text-ink-muted">{b.businessCode}</p></div>) },
                { key: "client", header: "Client", cell: (b) => (<Link href={`/admin/clients/${b.client.id}`} className="hover:underline">{b.client.name}</Link>) },
                { key: "cat", header: "Category", cell: (b) => b.category },
                { key: "status", header: "Status", cell: (b) => <StatusBadge status={b.status} /> },
                { key: "created", header: "Created", cell: (b) => formatDate(b.createdAt) },
              ]}
            />
            <Pagination base="/admin/businesses" params={{ q: sp.q, status: sp.status }} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} />
          </>
        )}
      </TableCard>
    </>
  );
}
