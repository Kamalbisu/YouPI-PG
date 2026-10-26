import Link from "next/link";
import { Alert, Badge, Card, CardBody, CardHeader, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { BusinessAdminActions } from "@/components/features/businesses/business-admin-actions";
import { BusinessSummary } from "@/components/features/businesses/business-summary";
import { load } from "@/components/features/clients/page-utils";
import { requireAdminPage } from "@/server/auth/page-guards";
import { getBusiness } from "@/server/services/businesses";

export const metadata = { title: "Business" };

export default async function AdminBusinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAdminPage();
  const { id } = await params;
  const res = await load(() => getBusiness(ctx, id));
  if (!res.ok) return <ErrorState message={res.error} />;
  const b = res.data;
  return (
    <>
      <PageHeader
        title={b.name}
        description={`${b.businessCode} - ${b.category}`}
        actions={<><StatusBadge status={b.status} /><BusinessAdminActions businessId={b.id} status={b.status} /></>}
      />
      {b.status === "PENDING_APPROVAL" && <div className="mb-5"><Alert tone="info">This business is waiting for your approval.</Alert></div>}
      {(b.status === "SUSPENDED" || b.status === "REJECTED") && (
        <div className="mb-5"><Alert tone="warn">This business is {b.status.toLowerCase()}.{b.statusReason ? ` Reason: ${b.statusReason}` : ""}</Alert></div>
      )}
      <div className="space-y-5">
        <Card>
          <CardHeader title="Client" />
          <CardBody className="text-sm">
            <Link href={`/admin/clients/${b.client.id}`} className="font-medium text-brand-600 hover:underline">{b.client.name}</Link>
            <span className="ml-2 text-ink-muted">{b.client.clientCode}</span>
            <span className="ml-2"><StatusBadge status={b.client.status} /></span>
          </CardBody>
        </Card>
        <BusinessSummary b={b} />
        <Card>
          <CardHeader title="Team" />
          <CardBody>
            <ul className="divide-y divide-line text-sm">
              {b.memberships.map((m) => (
                <li key={m.user.id} className="flex items-center justify-between gap-3 py-2">
                  <div><p className="font-medium">{m.user.name}</p><p className="text-xs text-ink-muted">{m.user.email}</p></div>
                  <div className="flex gap-2"><Badge tone={m.role === "OWNER" ? "blue" : "gray"}>{m.role === "OWNER" ? "Owner" : "Manager"}</Badge><StatusBadge status={m.user.status} /></div>
                </li>
              ))}
              {b.memberships.length === 0 && <li className="py-2 text-ink-muted">No team members.</li>}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
