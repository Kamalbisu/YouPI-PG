import type { Metadata } from "next";
import { Alert, ButtonLink, Card, CardBody, CardHeader, DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { fmtDate } from "@/components/shared/dates";
import { PrintButton } from "@/components/shared/print-button";
import { requireUserPage } from "@/server/auth/page-guards";
import { getPaymentForUser } from "@/server/services/payments";
import { formatRupees } from "@/lib/money";

export const metadata: Metadata = { title: "Payment receipt" };

const NOTE: Record<string, { tone: "success" | "error" | "info" | "warn"; text: string }> = {
  SUCCEEDED: { tone: "success", text: "Payment received. Thank you." },
  PARTIALLY_REFUNDED: { tone: "info", text: "Payment received. Part of it has been refunded." },
  REFUNDED: { tone: "info", text: "Payment received and fully refunded." },
  FAILED: { tone: "error", text: "This payment did not go through. You were not charged, or the amount will be returned by your bank." },
  PENDING: { tone: "warn", text: "We are waiting for the bank to confirm this payment. Refresh in a minute." },
  CREATED: { tone: "warn", text: "This payment was started but not completed." },
};

export default async function PaymentReceipt({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireUserPage();
  const { id } = await params;
  const p = await getPaymentForUser(ctx, id);
  const note = NOTE[p.status];
  const refunded = p.refunds.filter((r) => r.status === "PROCESSED").reduce((a, r) => a + r.amountPaise, 0);
  const rows: [string, React.ReactNode][] = [
    ["Reference", <span key="r" className="font-mono">{p.txnId}</span>],
    ["For", p.purpose],
    ["Amount", formatRupees(p.amountPaise)],
    ["Status", <StatusBadge key="s" status={p.status} />],
    ["Started", fmtDate(p.createdAt)],
    ...(p.paidAt ? [["Paid on", fmtDate(p.paidAt)] as [string, React.ReactNode]] : []),
    ...(p.easebuzzId ? [["Gateway ID", <span key="g" className="font-mono">{p.easebuzzId}</span>] as [string, React.ReactNode]] : []),
    ...(refunded ? [["Refunded so far", formatRupees(refunded)] as [string, React.ReactNode]] : []),
  ];
  return (
    <>
      <PageHeader title="Payment receipt" actions={<><PrintButton /><ButtonLink href="/dashboard/payments" variant="outline">All payments</ButtonLink></>} />
      <div className="max-w-2xl space-y-4">
        {note && <Alert tone={note.tone}>{note.text}{p.status === "FAILED" && p.failureReason ? ` (${p.failureReason})` : ""}</Alert>}
        <Card>
          <CardBody>
            <dl className="divide-y divide-line text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-2.5"><dt className="text-ink-muted">{k}</dt><dd className="text-right font-medium">{v}</dd></div>
              ))}
            </dl>
          </CardBody>
        </Card>
        {p.refunds.length > 0 && (
          <Card>
            <CardHeader title="Refunds" />
            <DataTable
              rows={p.refunds}
              rowKey={(r) => r.id}
              empty={{ title: "No refunds" }}
              columns={[
                { key: "when", header: "Date", cell: (r) => fmtDate(r.createdAt) },
                { key: "amt", header: "Amount", align: "right", cell: (r) => formatRupees(r.amountPaise) },
                { key: "st", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
                { key: "why", header: "Note", cell: (r) => r.reason ?? "-" },
              ]}
            />
          </Card>
        )}
      </div>
    </>
  );
}
