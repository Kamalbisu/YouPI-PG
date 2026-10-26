import { Alert, PageHeader } from "@/components/ui";
import { BusinessForm } from "@/components/features/businesses/business-form";
import { load } from "@/components/features/clients/page-utils";
import { requireClientPage } from "@/server/auth/page-guards";
import { businessQuota, listMyBusinesses } from "@/server/services/businesses";

export const metadata = { title: "Add business" };

export default async function NewBusinessPage() {
  const { ctx, actor } = await requireClientPage();
  const res = await load(async () => ({ mine: await listMyBusinesses(ctx), quota: await businessQuota(actor.clientId) }));
  const blocked = !res.ok
    ? res.error
    : res.data.mine.length > 0 && !actor.isOwner
      ? "Only the account owner can add a business."
      : res.data.quota.used >= res.data.quota.max
        ? `Your account is limited to ${res.data.quota.max} ${res.data.quota.max === 1 ? "business" : "businesses"}. Contact support to raise the limit.`
        : null;
  return (
    <>
      <PageHeader title="Add business" description="New businesses are reviewed before they go live." />
      {blocked ? <Alert tone="warn">{blocked}</Alert> : <BusinessForm />}
    </>
  );
}
