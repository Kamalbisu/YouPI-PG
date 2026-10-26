import type { Metadata } from "next";
import { PageHeader, Pagination, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { EventTable } from "@/components/auditor/event-table";
import { requireAuditorPage } from "@/server/auth/page-guards";
import { ACTIVITY_TYPES, listActivity } from "@/server/services/activity";

export const metadata: Metadata = { title: "Activity" };
type SP = Promise<Record<string, string | undefined>>;

export default async function ActivityPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireAuditorPage();
  const sp = await searchParams;
  const r = await listActivity(ctx, sp);
  const groups = ["auth", "payment", "refund", "transaction", "qr", "notification", "auditor"];
  return (
    <>
      <PageHeader title="Activity" description={`${r.total} event${r.total === 1 ? "" : "s"}. Every event is recorded once and can never be changed.`} />
      <TableCard>
        <FilterBar
          exportHref="/api/auditor/activity/export"
          filters={[
            { name: "q", label: "Search", type: "search", placeholder: "Payment ref, who, IP" },
            { name: "userId", label: "Customer ID", type: "search" },
            { name: "paymentId", label: "Payment ID", type: "search" },
            { name: "actorType", label: "Actor", type: "select", options: ["USER", "ADMIN", "AUDITOR", "SYSTEM", "GATEWAY"].map((v) => ({ value: v, label: v.toLowerCase() })) },
            { name: "type", label: "Event", type: "select", options: [...groups.map((g) => ({ value: g, label: `${g} (all)` })), ...ACTIVITY_TYPES.map((t) => ({ value: t, label: t }))] },
            { name: "from", label: "From", type: "date" },
            { name: "to", label: "To", type: "date" },
          ]}
        />
        <EventTable rows={r.items} />
        <Pagination base="/auditor" params={{ q: sp.q, userId: sp.userId, paymentId: sp.paymentId, actorType: sp.actorType, type: sp.type, from: sp.from, to: sp.to }} page={r.page} pageSize={r.pageSize} total={r.total} />
      </TableCard>
    </>
  );
}
