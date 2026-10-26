import Link from "next/link";
import { Plus } from "lucide-react";
import { ButtonLink, DataTable, ErrorState, PageHeader, Pagination, StatusBadge, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { formatDate } from "@/lib/utils";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listClients } from "@/server/services/clients";

export const metadata = { title: "Clients" };

export default async function ClientsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  const sp = await flatParams(searchParams);
  const res = await load(() => listClients(ctx, sp));
  return (
    <>
      <PageHeader
        title="Clients"
        description="Organisations that use the platform. Each client can run one or more businesses."
        actions={<ButtonLink href="/admin/clients/new"><Plus className="size-4" />New client</ButtonLink>}
      />
      <TableCard>
        <FilterBar
          filters={[
            { name: "q", label: "Search", type: "search", placeholder: "Name, email or code" },
            { name: "status", label: "Status", type: "select", options: [{ value: "ACTIVE", label: "Active" }, { value: "SUSPENDED", label: "Suspended" }, { value: "INACTIVE", label: "Inactive" }] },
          ]}
        />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(c) => c.id}
              empty={{ title: "No clients found", description: sp.q || sp.status ? "Try changing or clearing the filters." : "Create the first client to get started.", action: sp.q || sp.status ? undefined : <ButtonLink href="/admin/clients/new">New client</ButtonLink> }}
              columns={[
                { key: "name", header: "Client", cell: (c) => (<div><Link href={`/admin/clients/${c.id}`} className="font-medium text-brand-600 hover:underline">{c.name}</Link><p className="text-xs text-ink-muted">{c.clientCode}</p></div>) },
                { key: "contact", header: "Contact", cell: (c) => (<div><p>{c.contactName}</p><p className="text-xs text-ink-muted">{c.email}</p></div>) },
                { key: "biz", header: "Businesses", align: "right", cell: (c) => `${c._count.businesses} / ${c.maxBusinesses}` },
                { key: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
                { key: "created", header: "Created", cell: (c) => formatDate(c.createdAt) },
              ]}
            />
            <Pagination base="/admin/clients" params={{ q: sp.q, status: sp.status }} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} />
          </>
        )}
      </TableCard>
    </>
  );
}
