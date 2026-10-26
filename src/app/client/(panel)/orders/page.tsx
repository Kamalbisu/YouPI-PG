import { OrderListView } from "@/components/features/orders/orders-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "Orders" };

export default async function ClientOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireClientPage();
  return <OrderListView portal="client" ctx={ctx} searchParams={searchParams} />;
}
