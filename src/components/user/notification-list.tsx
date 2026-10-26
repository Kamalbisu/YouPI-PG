"use client";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export interface NotificationView { id: string; title: string; body: string; createdAt: string; read: boolean }

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export function NotificationList({ items }: { items: NotificationView[] }) {
  const router = useRouter();
  const unread = items.filter((n) => !n.read).length;
  const mark = useAction(async (body: { ids?: string[]; all?: boolean }) => {
    await api("/api/user/notifications/read", { method: "POST", body });
    router.refresh();
  });
  return (
    <Card>
      <CardHeader
        title="Notifications"
        description={unread ? `${unread} unread` : "All caught up"}
        action={unread > 0 ? <Button size="sm" variant="outline" loading={mark.pending} onClick={() => void mark.run({ all: true })}>Mark all read</Button> : undefined}
      />
      {items.length === 0 ? (
        <EmptyState icon={<Bell className="size-6" />} title="No notifications" description="Messages from the admin will show up here." />
      ) : (
        <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto">
          {items.map((n) => (
            <li key={n.id} className={n.read ? "px-5 py-3" : "bg-brand-50/60 px-5 py-3 dark:bg-brand-700/10"}>
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{n.title}</p>
                {!n.read && <Badge tone="blue">New</Badge>}
              </div>
              <p className="mt-1 text-sm whitespace-pre-line text-ink-muted">{n.body}</p>
              <div className="mt-2 flex items-center justify-between text-xs text-ink-muted">
                <span>{when(n.createdAt)}</span>
                {!n.read && <button className="font-medium text-brand-600 hover:underline" onClick={() => void mark.run({ ids: [n.id] })}>Mark as read</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
