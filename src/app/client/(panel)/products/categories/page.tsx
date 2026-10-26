import { CategoriesView } from "@/components/features/products/catalog-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "Product categories" };

export default async function ClientCategoriesViewPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireClientPage();
  return <CategoriesView portal="client" ctx={ctx} searchParams={searchParams} />;
}
