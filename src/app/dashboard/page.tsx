import type { Metadata } from "next";
import { QrCode } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { PayOnlineCard } from "@/components/user/pay-online-card";
import { QrPayCard } from "@/components/user/qr-pay-card";
import { NotificationList } from "@/components/user/notification-list";
import { requireUserPage } from "@/server/auth/page-guards";
import { listQrsForUser } from "@/server/services/qr";
import { db } from "@/lib/db";
import { gatewayStatus } from "@/server/services/payments";
import { listNotificationsForUser } from "@/server/services/notifications";

export const metadata: Metadata = { title: "Dashboard" };

export default async function UserDashboard() {
  const { actor } = await requireUserPage();
  const [qrs, notifications, me] = await Promise.all([
    listQrsForUser(actor),
    listNotificationsForUser(actor),
    db.user.findUnique({ where: { id: actor.userId }, select: { mobile: true } }),
  ]);
  return (
    <>
      <PageHeader title={`Hello, ${actor.name.split(" ")[0]}`} description="Pay online, or use a QR code and enter the transaction ID so we can confirm it." />
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <section aria-labelledby="qr-h" className="min-w-0 space-y-4">
          <PayOnlineCard available={gatewayStatus().configured} hasMobile={!!me?.mobile} />
          <h2 id="qr-h" className="sr-only">QR codes</h2>
          {qrs.length === 0 ? (
            <Card><EmptyState icon={<QrCode className="size-6" />} title="No QR code yet" description="When the admin gives you a QR code it will appear here." /></Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {qrs.map((q) => <QrPayCard key={q.id} qr={{ ...q, transactions: q.transactions.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })) }} />)}
            </div>
          )}
        </section>
        <section aria-labelledby="n-h" id="notifications" className="min-w-0">
          <NotificationList items={notifications.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() }))} />
        </section>
      </div>
    </>
  );
}
