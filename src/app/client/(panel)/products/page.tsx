import { ProductsView } from "@/components/features/products/catalog-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "Products" };

export default async function ClientProductsViewPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireClientPage();
  return <ProductsView portal="client" ctx={ctx} searchParams={searchParams} />;
}
