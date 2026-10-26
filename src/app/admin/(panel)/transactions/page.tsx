import { TransactionListView } from "@/components/features/transactions/txn-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Transactions" };

export default async function AdminTransactionsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  return <TransactionListView portal="admin" ctx={ctx} searchParams={searchParams} />;
}
