import { TransactionDetailView } from "@/components/features/transactions/txn-views";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Transaction" };

export default async function AdminTransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAdminPage();
  const { id } = await params;
  return <TransactionDetailView portal="admin" ctx={ctx} id={id} />;
}
