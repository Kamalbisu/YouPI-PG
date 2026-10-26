import { PageHeader } from "@/components/ui";
import { NewTicketForm } from "@/components/features/support/new-ticket-form";
import { requireClientPage } from "@/server/auth/page-guards";
import { listMyBusinesses } from "@/server/services/businesses";

export const metadata = { title: "New ticket" };

export default async function NewTicketPage() {
  const { ctx } = await requireClientPage();
  const businesses = await listMyBusinesses(ctx).catch(() => []);
  return (
    <>
      <PageHeader title="New ticket" description="Tell us what you need help with." />
      <NewTicketForm businesses={businesses.map((b) => ({ id: b.id, name: b.name }))} />
    </>
  );
}
