import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, PageHeader, Pagination, StatusBadge, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { TxnActions } from "@/components/admin/txn-actions";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listTransactionsAdmin } from "@/server/services/transactions";

export const metadata: Metadata = { title: "Transactions" };
type SP = Promise<Record<string, string | undefined>>;
const dt = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export default async function TransactionsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireAdminPage();
  const sp = await searchParams;
  const r = await listTransactionsAdmin(ctx, sp);
  return (
    <>
      <PageHeader title="Transactions" description={`${r.total} submission${r.total === 1 ? "" : "s"}`} />
      <TableCard>
        <FilterBar filters={[
          { name: "q", label: "Search", type: "search", placeholder: "Transaction ID, user or mobile" },
          { name: "status", label: "Status", type: "select", options: [{ value: "PENDING", label: "Pending" }, { value: "CONFIRMED", label: "Confirmed" }, { value: "REJECTED", label: "Rejected" }] },
        ]} />
        <DataTable
          rows={r.items}
          rowKey={(t) => t.id}
          empty={{ title: "No transactions found" }}
          columns={[
            { key: "txn", header: "Transaction ID", cell: (t) => <span className="font-mono">{t.txnId}</span> },
            { key: "user", header: "User", cell: (t) => <Link href={`/admin/users/${t.user.id}`} className="hover:underline">{t.user.name} <span className="text-ink-muted">@{t.user.username}</span></Link> },
            { key: "qr", header: "QR", cell: (t) => t.qr.label },
            { key: "st", header: "Status", cell: (t) => (
              <div><StatusBadge status={t.status} />{t.rejectReason && <p className="mt-1 max-w-[16rem] text-xs text-ink-muted">{t.rejectReason}</p>}</div>
            ) },
            { key: "when", header: "Submitted", cell: (t) => dt(t.createdAt) },
            { key: "by", header: "Reviewed", cell: (t) => (t.reviewer && t.reviewedAt ? `${t.reviewer.name}, ${dt(t.reviewedAt)}` : "-") },
            { key: "a", header: "", align: "right", cell: (t) => (t.status === "PENDING" ? <TxnActions id={t.id} txnId={t.txnId} /> : null) },
          ]}
        />
        <Pagination base="/admin/transactions" params={{ q: sp.q, status: sp.status }} page={r.page} pageSize={r.pageSize} total={r.total} />
      </TableCard>
    </>
  );
}
