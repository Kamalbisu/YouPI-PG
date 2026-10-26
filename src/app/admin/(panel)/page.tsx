import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, DataTable, PageHeader, Stat } from "@/components/ui";
import { TxnActions } from "@/components/admin/txn-actions";
import { requireAdminPage } from "@/server/auth/page-guards";
import { dashboardStats } from "@/server/services/users";
import { listTransactionsAdmin } from "@/server/services/transactions";

export const metadata: Metadata = { title: "Admin dashboard" };

export default async function AdminDashboard() {
  const { ctx } = await requireAdminPage();
  const [s, pending] = await Promise.all([dashboardStats(ctx), listTransactionsAdmin(ctx, { status: "PENDING", pageSize: 8 })]);
  return (
    <>
      <PageHeader title="Dashboard" description="What needs your attention" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Users" value={s.users} sub={`${s.activeUsers} active`} />
        <Stat label="QR codes" value={s.qrs} sub={`${s.activeQrs} active`} />
        <Stat label="Pending" value={s.pending} tone={s.pending ? "warn" : "default"} />
        <Stat label="Confirmed" value={s.confirmed} tone="good" />
        <Stat label="Rejected" value={s.rejected} tone={s.rejected ? "bad" : "default"} />
        <Stat label="All transactions" value={s.pending + s.confirmed + s.rejected} />
      </div>
      <Card className="mt-6 overflow-hidden">
        <CardHeader title="Waiting for confirmation" action={<Link href="/admin/transactions?status=PENDING" className="text-sm font-medium text-brand-600 hover:underline">View all</Link>} />
        <DataTable
          rows={pending.items}
          rowKey={(t) => t.id}
          empty={{ title: "Nothing pending", description: "New submissions will show up here." }}
          columns={[
            { key: "txn", header: "Transaction ID", cell: (t) => <span className="font-mono">{t.txnId}</span> },
            { key: "user", header: "User", cell: (t) => <Link href={`/admin/users/${t.user.id}`} className="hover:underline">{t.user.name}</Link> },
            { key: "qr", header: "QR", cell: (t) => t.qr.label },
            { key: "when", header: "Submitted", cell: (t) => t.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) },
            { key: "a", header: "", align: "right", cell: (t) => <TxnActions id={t.id} txnId={t.txnId} /> },
          ]}
        />
      </Card>
    </>
  );
}
