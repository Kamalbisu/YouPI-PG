import Link from "next/link";
import { Plus } from "lucide-react";
import { ButtonLink, DataTable, ErrorState, PageHeader, StatusBadge, TableCard } from "@/components/ui";
import { load } from "@/components/features/clients/page-utils";
import { formatDate } from "@/lib/utils";
import { requireClientPage } from "@/server/auth/page-guards";
import { businessQuota, listMyBusinesses } from "@/server/services/businesses";

export const metadata = { title: "Businesses" };

export default async function ClientBusinessesPage() {
  const { ctx, actor } = await requireClientPage();
  const res = await load(async () => ({ items: await listMyBusinesses(ctx), quota: await businessQuota(actor.clientId) }));
  if (!res.ok) return <><PageHeader title="Businesses" /><ErrorState message={res.error} /></>;
  const { items, quota } = res.data;
  const canAdd = (items.length === 0 || actor.isOwner) && quota.used < quota.max;
  return (
    <>
      <PageHeader
        title="Businesses"
        description={`${quota.used} of ${quota.max} used.`}
        actions={canAdd ? <ButtonLink href="/client/businesses/new"><Plus className="size-4" />Add business</ButtonLink> : undefined}
      />
      <TableCard>
        <DataTable
          rows={items}
          rowKey={(b) => b.id}
          empty={{
            title: "No businesses yet",
            description: "Add your first business. It becomes active after approval.",
            action: canAdd ? <ButtonLink href="/client/businesses/new">Add business</ButtonLink> : undefined,
          }}
          columns={[
            { key: "name", header: "Business", cell: (b) => (<div><Link href={`/client/businesses/${b.id}`} className="font-medium text-brand-600 hover:underline">{b.name}</Link><p className="text-xs text-ink-muted">{b.businessCode}</p></div>) },
            { key: "cat", header: "Category", cell: (b) => b.category },
            { key: "status", header: "Status", cell: (b) => <StatusBadge status={b.status} /> },
            { key: "created", header: "Created", cell: (b) => formatDate(b.createdAt) },
          ]}
        />
      </TableCard>
      {!canAdd && quota.used >= quota.max && actor.isOwner && (
        <p className="mt-3 text-sm text-ink-muted">You have reached your limit. Contact support to raise it.</p>
      )}
    </>
  );
}
