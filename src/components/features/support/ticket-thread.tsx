import { Badge } from "@/components/ui";
import { cn, formatDateTime } from "@/lib/utils";

type Msg = { id: string; body: string; createdAt: Date; author: { id: string; name: string; role: string } };

/** Read-only conversation thread. Server-rendered; message text is rendered as plain text. */
export function TicketThread({ messages }: { messages: Msg[] }) {
  return (
    <ol className="space-y-3">
      {messages.map((m) => {
        const staff = m.author.role === "SUPER_ADMIN";
        return (
          <li key={m.id} className={cn("rounded-lg border p-4", staff ? "border-brand-200 bg-brand-50/50 dark:border-brand-900 dark:bg-brand-950/30" : "border-line bg-surface")}>
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span className="font-medium text-ink">{m.author.name}</span>
              {staff && <Badge tone="blue">Support</Badge>}
              <span>{formatDateTime(m.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-ink">{m.body}</p>
          </li>
        );
      })}
    </ol>
  );
}
