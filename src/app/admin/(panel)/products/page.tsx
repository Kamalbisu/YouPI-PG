import { ProductsView } from "@/components/features/products/catalog-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Products" };

export default async function AdminProductsViewPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  return <ProductsView portal="admin" ctx={ctx} searchParams={searchParams} />;
}
