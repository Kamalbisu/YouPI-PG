import { Alert, Card, CardBody, CardHeader, ErrorState, PageHeader } from "@/components/ui";
import { load } from "@/components/features/clients/page-utils";
import { ReplyBox } from "@/components/features/support/reply-box";
import { TicketPriorityBadge, TicketStatusBadge } from "@/components/features/support/ticket-badges";
import { CloseTicketButton } from "@/components/features/support/ticket-controls";
import { TicketThread } from "@/components/features/support/ticket-thread";
import { requireClientPage } from "@/server/auth/page-guards";
import { getTicket } from "@/server/services/support";

export const metadata = { title: "Ticket" };

export default async function ClientTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireClientPage();
  const { id } = await params;
  const res = await load(() => getTicket(ctx, id));
  if (!res.ok) return <ErrorState message={res.error} />;
  const t = res.data;
  return (
    <>
      <PageHeader
        title={t.subject}
        description={`${t.ticketCode}${t.business ? ` - ${t.business.name}` : ""}`}
        actions={<><TicketStatusBadge status={t.status} /><TicketPriorityBadge priority={t.priority} />{t.status !== "CLOSED" && <CloseTicketButton ticketId={t.id} />}</>}
      />
      <div className="space-y-5">
        <TicketThread messages={t.messages} />
        {t.status === "CLOSED" ? (
          <Alert tone="info">This ticket is closed. Create a new ticket if you need more help.</Alert>
        ) : (
          <Card><CardHeader title="Reply" /><CardBody><ReplyBox ticketId={t.id} portal="client" /></CardBody></Card>
        )}
      </div>
    </>
  );
}
