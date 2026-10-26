import { ReconciliationView } from "@/components/features/payments/payments-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Reconciliation" };

export default async function AdminReconciliationPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  return <ReconciliationView ctx={ctx} searchParams={searchParams} />;
}
