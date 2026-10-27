import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, Pagination, DataTable, StatusBadge, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { ReconcileAllButton } from "@/components/admin/payment-actions";
import { fmtDate } from "@/components/shared/dates";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listPaymentsAdmin } from "@/server/services/payments";
import { formatRupees } from "@/lib/money";

export const metadata: Metadata = { title: "Payments" };
type SP = Promise<Record<string, string | undefined>>;
const STATUSES = ["CREATED", "PENDING", "SUCCEEDED", "FAILED", "PARTIALLY_REFUNDED", "REFUNDED"];

export default async function PaymentsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireAdminPage();
  const sp = await searchParams;
  const r = await listPaymentsAdmin(ctx, sp);
  return (
    <>
      <PageHeader title="Payments" description={`${r.total} online payment${r.total === 1 ? "" : "s"}`} actions={<ReconcileAllButton />} />
      <TableCard>
        <FilterBar filters={[
          { name: "q", label: "Search", type: "search", placeholder: "Transaction ID, gateway ID or user" },
          { name: "status", label: "Status", type: "select", options: STATUSES.map((v) => ({ value: v, label: v.toLowerCase().replace(/_/g, " ") })) },
          { name: "method", label: "Method", type: "select", options: [{ value: "EASEBUZZ", label: "Online (Easebuzz)" }, { value: "QR", label: "QR" }] },
          { name: "from", label: "From", type: "date" },
          { name: "to", label: "To", type: "date" },
        ]} />
        <DataTable
          rows={r.items}
          rowKey={(p) => p.id}
          empty={{ title: "No payments found" }}
          columns={[
            { key: "txn", header: "Reference", cell: (p) => <Link href={`/admin/payments/${p.id}`} className="font-mono hover:underline">{p.txnId}</Link> },
            { key: "user", header: "User", cell: (p) => <Link href={`/admin/users/${p.user.id}`} className="hover:underline">{p.user.name} <span className="text-ink-muted">@{p.user.username}</span></Link> },
            { key: "for", header: "For", cell: (p) => p.purpose },
            { key: "amt", header: "Amount", align: "right", cell: (p) => formatRupees(p.amountPaise) },
            { key: "st", header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
            { key: "ref", header: "Refunded", align: "right", cell: (p) => {
              const n = p.refunds.filter((x) => x.status === "PROCESSED").reduce((a, x) => a + x.amountPaise, 0);
              return n ? formatRupees(n) : "-";
            } },
            { key: "when", header: "Started", cell: (p) => fmtDate(p.createdAt) },
          ]}
        />
        <Pagination base="/admin/payments" params={{ q: sp.q, status: sp.status, method: sp.method, from: sp.from, to: sp.to }} page={r.page} pageSize={r.pageSize} total={r.total} />
      </TableCard>
    </>
  );
}
