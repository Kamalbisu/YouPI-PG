import type { Metadata } from "next";
import { Badge, Card, CardHeader, DataTable, PageHeader, Pagination } from "@/components/ui";
import { NotifyForm } from "@/components/admin/notify-form";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listNotificationsAdmin } from "@/server/services/notifications";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Notifications" };
type SP = Promise<Record<string, string | undefined>>;

export default async function NotificationsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireAdminPage();
  const sp = await searchParams;
  const [r, users] = await Promise.all([
    listNotificationsAdmin(ctx, sp),
    db.user.findMany({ where: { role: "USER", status: "ACTIVE" }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true, username: true } }),
  ]);
  return (
    <>
      <PageHeader title="Notifications" description="Send a message to one user or everyone" />
      <div className="grid gap-6 xl:grid-cols-[24rem_1fr]">
        <NotifyForm users={users} />
        <Card className="min-w-0 overflow-hidden">
          <CardHeader title="Sent" />
          <DataTable
            rows={r.items}
            rowKey={(n) => n.id}
            empty={{ title: "Nothing sent yet" }}
            columns={[
              { key: "to", header: "To", cell: (n) => (n.user ? `${n.user.name} (@${n.user.username})` : <Badge tone="blue">All users</Badge>) },
              { key: "msg", header: "Message", cell: (n) => (<div className="max-w-sm"><p className="font-medium">{n.title}</p><p className="line-clamp-2 text-ink-muted">{n.body}</p></div>) },
              { key: "read", header: "Read by", align: "right", cell: (n) => n._count.reads },
              { key: "when", header: "Sent", cell: (n) => n.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) },
            ]}
          />
          <Pagination base="/admin/notifications" params={{}} page={r.page} pageSize={r.pageSize} total={r.total} />
        </Card>
      </div>
    </>
  );
}
