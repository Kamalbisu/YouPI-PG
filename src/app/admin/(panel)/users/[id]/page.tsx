import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Card, CardBody, CardHeader, DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { UserStatusButton } from "@/components/admin/user-status-button";
import { NotifyForm } from "@/components/admin/notify-form";
import { requireAdminPage } from "@/server/auth/page-guards";
import { getUserDetail } from "@/server/services/users";
import { formatRupees } from "@/lib/money";

export const metadata: Metadata = { title: "User" };
const dt = (d: Date | null) => (d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Never");

export default async function UserDetail({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAdminPage();
  const { id } = await params;
  const u = await getUserDetail(ctx, id);
  const rows: [string, React.ReactNode][] = [
    ["Name", u.name], ["Username", `@${u.username}`], ["Mobile", u.mobile ?? "-"],
    ["Status", <StatusBadge key="s" status={u.status} />], ["Signed up", dt(u.createdAt)], ["Last login", dt(u.lastLoginAt)],
  ];
  return (
    <>
      <Link href="/admin/users" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ChevronLeft className="size-4" />All users</Link>
      <PageHeader title={u.name} description={`@${u.username}`} actions={<UserStatusButton id={u.id} status={u.status} name={u.name} />} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2.5 text-sm">
              {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-ink-muted">{k}</dt><dd>{v}</dd></div>))}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Assigned QR codes" description="QR codes marked for all users are not listed here." />
          {u.assignments.length === 0 ? <EmptyState title="No QR assigned" description="Assign one from the QR codes page." /> : (
            <ul className="divide-y divide-line">
              {u.assignments.map(({ qr }) => (
                <li key={qr.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="font-medium">{qr.label}{qr.amountPaise != null && <span className="ml-2 font-normal text-ink-muted">{formatRupees(qr.amountPaise)}</span>}</span>
                  <StatusBadge status={qr.active ? "ACTIVE" : "INACTIVE"} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card className="mt-6 overflow-hidden">
        <CardHeader title="Transaction history" />
        <DataTable
          rows={u.transactions}
          rowKey={(t) => t.id}
          empty={{ title: "No transactions yet" }}
          columns={[
            { key: "txn", header: "Transaction ID", cell: (t) => <span className="font-mono">{t.txnId}</span> },
            { key: "qr", header: "QR", cell: (t) => t.qr.label },
            { key: "st", header: "Status", cell: (t) => <StatusBadge status={t.status} /> },
            { key: "why", header: "Reason", cell: (t) => t.rejectReason ?? "-" },
            { key: "when", header: "Submitted", cell: (t) => dt(t.createdAt) },
            { key: "by", header: "Reviewed by", cell: (t) => (t.reviewer ? `${t.reviewer.name}, ${dt(t.reviewedAt)}` : "-") },
          ]}
        />
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotifyForm fixedUserId={u.id} />
        <Card>
          <CardHeader title="Notifications sent to this user" />
          {u.notificationsIn.length === 0 ? <EmptyState title="Nothing sent yet" /> : (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto">
              {u.notificationsIn.map((n) => (
                <li key={n.id} className="px-5 py-3 text-sm">
                  <p className="font-medium">{n.title}</p>
                  <p className="text-ink-muted whitespace-pre-line">{n.body}</p>
                  <p className="mt-1 text-xs text-ink-muted">{dt(n.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
