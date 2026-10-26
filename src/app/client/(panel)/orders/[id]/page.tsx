import { OrderDetailView } from "@/components/features/orders/orders-views";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "Order" };

export default async function ClientOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireClientPage();
  const { id } = await params;
  return <OrderDetailView portal="client" ctx={ctx} id={id} />;
}
