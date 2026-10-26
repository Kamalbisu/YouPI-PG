import { CategoriesView } from "@/components/features/products/catalog-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Product categories" };

export default async function AdminCategoriesViewPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  return <CategoriesView portal="admin" ctx={ctx} searchParams={searchParams} />;
}
