import Link from "next/link";
import { Badge, DataTable, StatusBadge } from "@/components/ui";
import { fmtDate } from "@/components/shared/dates";

export interface EventRow {
  id: string;
  createdAt: Date;
  type: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  targetUserId: string | null;
  targetUser?: { id: string; name: string; username: string } | null;
  paymentId: string | null;
  paymentRef: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
}

const ACTOR_TONE = { USER: "blue", ADMIN: "amber", AUDITOR: "gray", SYSTEM: "gray", GATEWAY: "green" } as const;

export function EventTable({ rows, empty = "No activity found" }: { rows: EventRow[]; empty?: string }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(e) => e.id}
      empty={{ title: empty }}
      columns={[
        { key: "when", header: "Time", cell: (e) => <span className="whitespace-nowrap">{fmtDate(e.createdAt)}</span> },
        { key: "type", header: "Event", cell: (e) => <span className="font-mono text-xs">{e.type}</span> },
        { key: "actor", header: "Who", cell: (e) => (
          <div>
            <Badge tone={ACTOR_TONE[e.actorType as keyof typeof ACTOR_TONE] ?? "gray"}>{e.actorType.toLowerCase()}</Badge>
            {e.actorName && <p className="mt-0.5 text-xs text-ink-muted">@{e.actorName}</p>}
          </div>
        ) },
        { key: "user", header: "Customer", cell: (e) => (e.targetUserId ? <Link className="hover:underline" href={`/auditor/users/${e.targetUserId}`}>{e.targetUser ? e.targetUser.name : e.targetUserId.slice(0, 8)}</Link> : "-") },
        { key: "pay", header: "Payment", cell: (e) => (e.paymentId ? <Link className="font-mono text-xs hover:underline" href={`/auditor/payments/${e.paymentId}`}>{e.paymentRef ?? e.paymentId.slice(0, 8)}</Link> : (e.paymentRef ?? "-")) },
        { key: "st", header: "Status change", cell: (e) => (e.fromStatus || e.toStatus ? (
          <span className="inline-flex items-center gap-1.5">{e.fromStatus ? <StatusBadge status={e.fromStatus} /> : "-"}<span aria-hidden>→</span>{e.toStatus ? <StatusBadge status={e.toStatus} /> : "-"}</span>
        ) : "-") },
        { key: "ip", header: "Source", cell: (e) => (
          <details className="text-xs">
            <summary className="cursor-pointer text-ink-muted">{e.ip ?? "no IP"}</summary>
            <p className="mt-1 max-w-[18rem] break-words text-ink-muted">{e.userAgent ?? "no user agent"}</p>
            {e.metadata != null && Object.keys(e.metadata as object).length > 0 && <pre className="mt-1 max-w-[18rem] overflow-auto rounded bg-surface-muted p-2">{JSON.stringify(e.metadata, null, 1)}</pre>}
          </details>
        ) },
      ]}
    />
  );
}
