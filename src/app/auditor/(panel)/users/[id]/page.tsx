import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Card, PageHeader, Pagination } from "@/components/ui";
import { EventTable } from "@/components/auditor/event-table";
import { requireAuditorPage } from "@/server/auth/page-guards";
import { userTimeline } from "@/server/services/activity";

export const metadata: Metadata = { title: "Customer timeline" };

export default async function UserTimelinePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx } = await requireAuditorPage();
  const { id } = await params;
  const sp = await searchParams;
  const t = await userTimeline(ctx, id, sp);
  if (!t) notFound();
  return (
    <>
      <Link href="/auditor" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ChevronLeft className="size-4" />All activity</Link>
      <PageHeader title={t.user.name} description={`@${t.user.username} · ${t.events.total} event${t.events.total === 1 ? "" : "s"}, newest first`} />
      <Card className="overflow-hidden">
        <EventTable rows={t.events.items} />
        <Pagination base={`/auditor/users/${id}`} params={{}} page={t.events.page} pageSize={t.events.pageSize} total={t.events.total} />
      </Card>
    </>
  );
}
