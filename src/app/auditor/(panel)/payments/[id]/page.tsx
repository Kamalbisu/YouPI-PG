import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Card, CardBody, CardHeader, DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { EventTable } from "@/components/auditor/event-table";
import { fmtDate } from "@/components/shared/dates";
import { requireAuditorPage } from "@/server/auth/page-guards";
import { paymentTimeline } from "@/server/services/activity";
import { formatRupees } from "@/lib/money";

export const metadata: Metadata = { title: "Payment timeline" };

export default async function PaymentTimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAuditorPage();
  const { id } = await params;
  const t = await paymentTimeline(ctx, id);
  if (!t) notFound();
  const { payment: p, events } = t;
  const rows: [string, React.ReactNode][] = [
    ["Customer", <Link key="u" className="hover:underline" href={`/auditor/users/${p.user.id}`}>{p.user.name} (@{p.user.username})</Link>],
    ["For", p.purpose],
    ["Amount", formatRupees(p.amountPaise)],
    ["Paid", p.paidAmountPaise != null ? formatRupees(p.paidAmountPaise) : "-"],
    ["Status", <StatusBadge key="s" status={p.status} />],
    ["Gateway ID", p.easebuzzId ?? "-"],
    ["Started", fmtDate(p.createdAt)],
  ];
  return (
    <>
      <Link href="/auditor" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ChevronLeft className="size-4" />All activity</Link>
      <PageHeader title={`Payment ${p.txnId}`} description="Everything that happened to this payment, oldest first." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Payment" />
          <CardBody>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2.5 text-sm">
              {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-ink-muted">{k}</dt><dd>{v}</dd></div>))}
            </dl>
          </CardBody>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Refunds" />
          <DataTable
            rows={p.refunds}
            rowKey={(r) => r.id}
            empty={{ title: "No refunds" }}
            columns={[
              { key: "id", header: "Refund ID", cell: (r) => <span className="font-mono text-xs">{r.merchantRefundId}</span> },
              { key: "amt", header: "Amount", align: "right", cell: (r) => formatRupees(r.amountPaise) },
              { key: "st", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
            ]}
          />
        </Card>
      </div>
      <Card className="mt-6 overflow-hidden">
        <CardHeader title="Timeline" />
        <EventTable rows={events} empty="No events recorded" />
      </Card>
    </>
  );
}
