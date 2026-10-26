import Link from "next/link";
import { Alert, Card, CardBody, CardHeader, ErrorState, PageHeader } from "@/components/ui";
import { load } from "@/components/features/clients/page-utils";
import { ReplyBox } from "@/components/features/support/reply-box";
import { TicketPriorityBadge, TicketStatusBadge } from "@/components/features/support/ticket-badges";
import { AdminTicketControls } from "@/components/features/support/ticket-controls";
import { TicketThread } from "@/components/features/support/ticket-thread";
import { requireAdminPage } from "@/server/auth/page-guards";
import { getTicket } from "@/server/services/support";

export const metadata = { title: "Ticket" };

export default async function AdminTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAdminPage();
  const { id } = await params;
  const res = await load(() => getTicket(ctx, id));
  if (!res.ok) return <ErrorState message={res.error} />;
  const t = res.data;
  return (
    <>
      <PageHeader title={t.subject} description={`${t.ticketCode} from ${t.client.name}`} actions={<><TicketStatusBadge status={t.status} /><TicketPriorityBadge priority={t.priority} /></>} />
      <div className="space-y-5">
        <Card>
          <CardBody className="space-y-3">
            <AdminTicketControls ticketId={t.id} status={t.status} priority={t.priority} />
            <p className="text-sm text-ink-muted">
              Client: <Link href={`/admin/clients/${t.client.id}`} className="text-brand-600 hover:underline">{t.client.name}</Link>
              {t.business && <> - Business: <Link href={`/admin/businesses/${t.business.id}`} className="text-brand-600 hover:underline">{t.business.name}</Link></>}
              {" "}- Opened by {t.creator.name} ({t.creator.email})
            </p>
          </CardBody>
        </Card>
        <TicketThread messages={t.messages} />
        {t.status === "CLOSED" ? (
          <Alert tone="info">This ticket is closed. Change its status to reopen it before replying.</Alert>
        ) : (
          <Card><CardHeader title="Reply" /><CardBody><ReplyBox ticketId={t.id} portal="admin" /></CardBody></Card>
        )}
      </div>
    </>
  );
}
