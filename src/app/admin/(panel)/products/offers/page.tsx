import { OffersView } from "@/components/features/products/catalog-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Offers" };

export default async function AdminOffersViewPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  return <OffersView portal="admin" ctx={ctx} searchParams={searchParams} />;
}
