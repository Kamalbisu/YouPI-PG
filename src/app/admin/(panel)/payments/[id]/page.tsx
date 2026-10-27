import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Card, CardBody, CardHeader, DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { ReconcileButton, RefundButton, RetryRefundButton } from "@/components/admin/payment-actions";
import { fmtDate } from "@/components/shared/dates";
import { requireAdminPage } from "@/server/auth/page-guards";
import { getPaymentAdmin } from "@/server/services/payments";
import { formatRupees } from "@/lib/money";

export const metadata: Metadata = { title: "Payment" };

export default async function PaymentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAdminPage();
  const { id } = await params;
  const p = await getPaymentAdmin(ctx, id);
  // Same rule the server enforces: queued, processing and processed refunds count against the paid amount.
  const used = p.refunds.filter((r) => r.status !== "FAILED").reduce((a, r) => a + r.amountPaise, 0);
  const refundable = Math.max(0, (p.paidAmountPaise ?? 0) - used);
  const canRefund = p.method === "EASEBUZZ" && !!p.easebuzzId && ["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(p.status) && refundable > 0;
  const canCheck = p.method === "EASEBUZZ" && ["CREATED", "PENDING"].includes(p.status);
  const rows: [string, React.ReactNode][] = [
    ["Reference", <span key="r" className="font-mono">{p.txnId}</span>],
    ["User", <Link key="u" href={`/admin/users/${p.user.id}`} className="hover:underline">{p.user.name} (@{p.user.username})</Link>],
    ["Mobile", p.user.mobile ?? "-"],
    ["For", p.purpose],
    ["Amount asked", formatRupees(p.amountPaise)],
    ["Amount paid", p.paidAmountPaise != null ? formatRupees(p.paidAmountPaise) : "-"],
    ["Status", <StatusBadge key="s" status={p.status} />],
    ["Gateway ID", p.easebuzzId ?? "-"],
    ["Pay mode", p.gatewayMode ?? "-"],
    ["Started", fmtDate(p.createdAt)],
    ["Paid on", fmtDate(p.paidAt)],
    ["Failure reason", p.failureReason ?? "-"],
  ];
  return (
    <>
      <Link href="/admin/payments" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ChevronLeft className="size-4" />All payments</Link>
      <PageHeader
        title={formatRupees(p.amountPaise)}
        description={p.txnId}
        actions={<>
          {canCheck && <ReconcileButton id={p.id} />}
          {canRefund && <RefundButton id={p.id} txnId={p.txnId} refundableRupees={(refundable / 100).toFixed(2)} />}
        </>}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2.5 text-sm">
              {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-ink-muted">{k}</dt><dd className="break-words">{v}</dd></div>))}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Gateway response" description="Last answer from the gateway. Secrets are removed." />
          <CardBody>
            <pre className="max-h-96 overflow-auto rounded-lg bg-surface-muted p-3 text-xs">{p.gatewayResponse ? JSON.stringify(p.gatewayResponse, null, 2) : "Nothing received yet."}</pre>
          </CardBody>
        </Card>
      </div>
      <Card className="mt-6 overflow-hidden">
        <CardHeader title="Refunds" description={`Refunded or in progress: ${formatRupees(used)}`} />
        <DataTable
          rows={p.refunds}
          rowKey={(r) => r.id}
          empty={{ title: "No refunds" }}
          columns={[
            { key: "id", header: "Refund ID", cell: (r) => <span className="font-mono">{r.merchantRefundId}</span> },
            { key: "amt", header: "Amount", align: "right", cell: (r) => formatRupees(r.amountPaise) },
            { key: "st", header: "Status", cell: (r) => (
              <div><StatusBadge status={r.status} />{r.failureReason && <p className="mt-1 max-w-[16rem] text-xs text-ink-muted">{r.failureReason}</p>}</div>
            ) },
            { key: "why", header: "Reason", cell: (r) => r.reason ?? "-" },
            { key: "when", header: "Requested", cell: (r) => fmtDate(r.createdAt) },
            { key: "a", header: "", align: "right", cell: (r) => (r.status === "QUEUED" ? <RetryRefundButton id={r.id} /> : null) },
          ]}
        />
      </Card>
    </>
  );
}
