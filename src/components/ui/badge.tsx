import { cn } from "@/lib/utils";

const tones = {
  gray: "bg-surface-muted text-ink-muted",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blue: "bg-brand-100 text-brand-700 dark:bg-brand-700/25 dark:text-brand-100",
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = "gray", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "green", CONFIRMED: "green", DISABLED: "red", SUCCEEDED: "green", PAID: "green", APPROVED: "green", RESOLVED: "green", CLOSED: "gray", AVAILABLE: "green", PROCESSED: "green",
  PENDING: "amber", PENDING_APPROVAL: "amber", CREATED: "gray", OPEN: "blue", INVITED: "blue", AUTHORIZED: "blue", PARTIALLY_REFUNDED: "amber", IN_PROGRESS: "blue",
  FAILED: "red", REJECTED: "red", SUSPENDED: "red", CANCELLED: "gray", EXPIRED: "gray", REVOKED: "red", INACTIVE: "gray", REFUNDED: "blue", DISPUTED: "red",
};
export function StatusBadge({ status }: { status: string }) {
  const label = status.toLowerCase().replace(/_/g, " ");
  return <Badge tone={STATUS_TONE[status] ?? "gray"} className="capitalize">{label}</Badge>;
}
