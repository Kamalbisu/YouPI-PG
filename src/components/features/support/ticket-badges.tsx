import { Badge } from "@/components/ui";

const STATUS: Record<string, { label: string; tone: "gray" | "green" | "red" | "amber" | "blue" }> = {
  OPEN: { label: "Open", tone: "amber" },
  IN_PROGRESS: { label: "In progress", tone: "blue" },
  RESOLVED: { label: "Resolved", tone: "green" },
  CLOSED: { label: "Closed", tone: "gray" },
};
const PRIORITY: Record<string, { label: string; tone: "gray" | "green" | "red" | "amber" | "blue" }> = {
  LOW: { label: "Low", tone: "gray" },
  NORMAL: { label: "Normal", tone: "blue" },
  HIGH: { label: "High", tone: "red" },
};

export function TicketStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "gray" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
export function TicketPriorityBadge({ priority }: { priority: string }) {
  const s = PRIORITY[priority] ?? { label: priority, tone: "gray" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
