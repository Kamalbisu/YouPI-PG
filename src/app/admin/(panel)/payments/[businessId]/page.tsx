import { BusinessPaymentsView } from "@/components/features/payments/payments-views";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Business payments" };

export default async function AdminBusinessPaymentsPage({ params }: { params: Promise<{ businessId: string }> }) {
  const { ctx } = await requireAdminPage();
  const { businessId } = await params;
  return <BusinessPaymentsView ctx={ctx} businessId={businessId} />;
}
