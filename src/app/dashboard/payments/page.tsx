import type { Metadata } from "next";
import Link from "next/link";
import { CreditCard } from "lucide-react";
import { ButtonLink, DataTable, PageHeader, Pagination, StatusBadge, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { fmtDate } from "@/components/shared/dates";
import { requireUserPage } from "@/server/auth/page-guards";
import { listPaymentsForUser } from "@/server/services/payments";
import { formatRupees } from "@/lib/money";

export const metadata: Metadata = { title: "My payments" };
type SP = Promise<Record<string, string | undefined>>;

export default async function PaymentsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireUserPage();
  const sp = await searchParams;
  const r = await listPaymentsForUser(ctx, sp);
  return (
    <>
      <PageHeader title="My payments" description={`${r.total} online payment${r.total === 1 ? "" : "s"}`} actions={<ButtonLink href="/dashboard"><CreditCard className="size-4" />Pay online</ButtonLink>} />
      <TableCard>
        <FilterBar filters={[{ name: "status", label: "Status", type: "select", options: ["CREATED", "PENDING", "SUCCEEDED", "FAILED", "PARTIALLY_REFUNDED", "REFUNDED"].map((v) => ({ value: v, label: v.toLowerCase().replace(/_/g, " ") })) }]} />
        <DataTable
          rows={r.items}
          rowKey={(p) => p.id}
          empty={{ title: "No payments yet", description: "Payments you make online will show up here." }}
          columns={[
            { key: "txn", header: "Reference", cell: (p) => <Link href={`/dashboard/payments/${p.id}`} className="font-mono hover:underline">{p.txnId}</Link> },
            { key: "purpose", header: "For", cell: (p) => p.purpose },
            { key: "amt", header: "Amount", align: "right", cell: (p) => formatRupees(p.amountPaise) },
            { key: "st", header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
            { key: "ref", header: "Refunded", align: "right", cell: (p) => {
              const n = p.refunds.filter((x) => x.status === "PROCESSED").reduce((a, x) => a + x.amountPaise, 0);
              return n ? formatRupees(n) : "-";
            } },
            { key: "when", header: "Date", cell: (p) => fmtDate(p.createdAt) },
          ]}
        />
        <Pagination base="/dashboard/payments" params={{ status: sp.status }} page={r.page} pageSize={r.pageSize} total={r.total} />
      </TableCard>
    </>
  );
}
