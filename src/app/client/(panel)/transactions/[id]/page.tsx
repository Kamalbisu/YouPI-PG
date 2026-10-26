import { TransactionDetailView } from "@/components/features/transactions/txn-views";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "Transaction" };

export default async function ClientTransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireClientPage();
  const { id } = await params;
  return <TransactionDetailView portal="client" ctx={ctx} id={id} />;
}
