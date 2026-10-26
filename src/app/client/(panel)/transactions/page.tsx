import { TransactionListView } from "@/components/features/transactions/txn-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "Transactions" };

export default async function ClientTransactionsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireClientPage();
  return <TransactionListView portal="client" ctx={ctx} searchParams={searchParams} />;
}
