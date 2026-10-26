import { PaymentsOverviewView } from "@/components/features/payments/payments-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Payments" };

export default async function AdminPaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  return <PaymentsOverviewView ctx={ctx} searchParams={searchParams} />;
}
