import { Alert, Card, CardBody, CardHeader, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { BusinessForm, bpsToPercent } from "@/components/features/businesses/business-form";
import { LogoUpload } from "@/components/features/businesses/logo-upload";
import { TeamPanel } from "@/components/features/businesses/team-panel";
import { load } from "@/components/features/clients/page-utils";
import { requireClientPage } from "@/server/auth/page-guards";
import { hasPermission } from "@/server/auth/guards";
import { getBusiness } from "@/server/services/businesses";
import { listTeam } from "@/server/services/team";

export const metadata = { title: "Business" };

export default async function ClientBusinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, actor } = await requireClientPage();
  const { id } = await params;
  const canEdit = hasPermission(actor, "settings.manage");
  const canTeam = hasPermission(actor, "team.manage");
  const res = await load(async () => ({ b: await getBusiness(ctx, id), team: canTeam ? await listTeam(ctx, id) : null }));
  if (!res.ok) return <ErrorState message={res.error} />;
  const { b, team } = res.data;
  return (
    <>
      <PageHeader title={b.name} description={`${b.businessCode} - ${b.category}`} actions={<StatusBadge status={b.status} />} />
      {b.status === "PENDING_APPROVAL" && <div className="mb-5"><Alert tone="info">This business is waiting for approval. You can still complete its profile.</Alert></div>}
      {(b.status === "REJECTED" || b.status === "SUSPENDED") && (
        <div className="mb-5"><Alert tone="warn">This business is {b.status.toLowerCase()}.{b.statusReason ? ` Reason: ${b.statusReason}` : ""} Contact support if you need help.</Alert></div>
      )}
      <div className="space-y-5">
        <Card>
          <CardHeader title="Logo" />
          <CardBody>
            {canEdit ? <LogoUpload businessId={b.id} logoFileId={b.logoFileId} businessName={b.name} /> : <p className="text-sm text-ink-muted">Only the account owner can change the logo.</p>}
          </CardBody>
        </Card>
        <BusinessForm
          businessId={b.id}
          readOnly={!canEdit}
          initial={{
            name: b.name, category: b.category, description: b.description ?? "", addressLine: b.addressLine ?? "", city: b.city ?? "", state: b.state ?? "",
            pincode: b.pincode ?? "", contactPhone: b.contactPhone ?? "", contactEmail: b.contactEmail ?? "", ownerName: b.ownerName ?? "", ownerPhone: b.ownerPhone ?? "",
            hoursText: b.hoursText ?? "", acceptingOrders: b.acceptingOrders, pricesIncludeTax: b.pricesIncludeTax, defaultTaxPercent: bpsToPercent(b.defaultTaxBps),
            allowCustomAmount: b.allowCustomAmount,
          }}
        />
        {team && (
          <Card>
            <CardHeader title="Team" />
            <CardBody><TeamPanel businessId={b.id} currentUserId={actor.userId} members={team.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, status: m.status, lastLoginAt: m.lastLoginAt }))} /></CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
