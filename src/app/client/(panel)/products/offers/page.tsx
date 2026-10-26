import { OffersView } from "@/components/features/products/catalog-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "Offers" };

export default async function ClientOffersViewPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireClientPage();
  return <OffersView portal="client" ctx={ctx} searchParams={searchParams} />;
}
