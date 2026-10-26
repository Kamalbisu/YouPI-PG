import { Package } from "lucide-react";
import { Alert, Badge, DataTable, ErrorState, LinkTabs, PageHeader, Pagination, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { formatMinor } from "@/lib/money";
import type { Ctx } from "@/server/auth/types";
import { listMyBusinesses, listBusinesses } from "@/server/services/businesses";
import { listCategories } from "@/server/services/categories";
import { listOffers } from "@/server/services/offers";
import { listProducts } from "@/server/services/products";
import { describeDiscount, type BusinessOption, type Portal } from "./catalog-format";
import { CategoryTable, NewCategoryButton } from "./category-manager";
import { NewOfferButton, OfferTable } from "./offer-manager";
import { NewProductButton, ProductRowActions } from "./product-actions";

type TabKey = "products" | "categories" | "offers";

async function businessOptions(ctx: Ctx, portal: Portal): Promise<BusinessOption[]> {
  if (portal === "admin") {
    const page = await listBusinesses(ctx, { status: "ACTIVE", pageSize: 100 });
    return page.items.map((b) => ({ id: b.id, name: `${b.name} (${b.client.name})` }));
  }
  const rows = await listMyBusinesses(ctx);
  return rows.filter((b) => b.status === "ACTIVE").map((b) => ({ id: b.id, name: b.name }));
}

function Header({ portal, active, actions }: { portal: Portal; active: TabKey; actions?: React.ReactNode }) {
  const base = `/${portal}/products`;
  return (
    <>
      <PageHeader
        title="Products"
        description={portal === "admin" ? "Catalogue, categories and coupon offers across all businesses." : "Manage what you sell, how it is grouped and the coupons you offer."}
        actions={actions}
      />
      <LinkTabs
        active={active}
        tabs={[
          { key: "products", label: "Products", href: base },
          { key: "categories", label: "Categories", href: `${base}/categories` },
          { key: "offers", label: "Offers", href: `${base}/offers` },
        ]}
      />
    </>
  );
}

const noBusinessNote = (portal: Portal) => (
  <Alert tone="info">
    {portal === "admin"
      ? "There are no active businesses yet. Items can be added once a business has been approved."
      : "You need an active business before you can add items. Businesses become active once they are approved."}
  </Alert>
);

export async function ProductsView({ portal, ctx, searchParams }: { portal: Portal; ctx: Ctx; searchParams: SearchParams }) {
  const sp = await flatParams(searchParams);
  const [res, biz] = await Promise.all([load(() => listProducts(ctx, sp)), load(() => businessOptions(ctx, portal))]);
  const businesses = biz.ok ? biz.data : [];
  const showBusiness = portal === "admin" || businesses.length > 1;
  const scopedBusinessId = sp.businessId || (businesses.length === 1 ? businesses[0].id : undefined);
  const cats = scopedBusinessId ? await load(() => listCategories(ctx, { businessId: scopedBusinessId })) : null;
  const filtered = Boolean(sp.q || sp.status || sp.categoryId || sp.businessId);

  const filters = [
    { name: "q", label: "Search", type: "search" as const, placeholder: "Name, SKU or description" },
    ...(showBusiness ? [{ name: "businessId", label: "Business", type: "select" as const, options: businesses.map((b) => ({ value: b.id, label: b.name })) }] : []),
    ...(cats?.ok
      ? [{ name: "categoryId", label: "Category", type: "select" as const, options: [{ value: "none", label: "Uncategorised" }, ...cats.data.map((c) => ({ value: c.id, label: c.name }))] }]
      : []),
    {
      name: "status",
      label: "Status",
      type: "select" as const,
      options: [
        { value: "available", label: "Available" },
        { value: "unavailable", label: "Unavailable" },
        { value: "archived", label: "Archived" },
        { value: "all", label: "Including archived" },
      ],
    },
  ];

  return (
    <>
      <Header portal={portal} active="products" actions={<NewProductButton portal={portal} businesses={businesses} />} />
      {biz.ok && businesses.length === 0 && <div className="mb-4">{noBusinessNote(portal)}</div>}
      <TableCard>
        <FilterBar filters={filters} />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(p) => p.id}
              empty={{
                title: filtered ? "No products match" : "No products yet",
                description: filtered ? "Try changing or clearing the filters." : "Add your first product or service to start taking orders.",
                action: filtered ? undefined : <NewProductButton portal={portal} businesses={businesses} />,
              }}
              columns={[
                {
                  key: "name",
                  header: "Product",
                  cell: (p) => (
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-muted text-ink-muted">
                        {p.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
                        ) : (
                          <Package className="size-5" aria-hidden />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{p.name}</p>
                        <p className="text-xs text-ink-muted">{p.kind === "SERVICE" ? "Service" : "Product"}{p.sku ? ` / ${p.sku}` : ""}</p>
                      </div>
                    </div>
                  ),
                },
                ...(showBusiness ? [{ key: "biz", header: "Business", cell: (p: (typeof res.data.items)[number]) => p.business.name }] : []),
                { key: "cat", header: "Category", cell: (p) => p.category?.name ?? <span className="text-ink-muted">None</span> },
                {
                  key: "price",
                  header: "Price",
                  align: "right" as const,
                  cell: (p) => (
                    <div>
                      <p className="tabular-nums">{formatMinor(p.priceMinor)}</p>
                      {p.discountType !== "NONE" && <p className="text-xs text-ink-muted">{describeDiscount(p)}</p>}
                    </div>
                  ),
                },
                { key: "stock", header: "Stock", align: "right" as const, cell: (p) => (p.trackInventory ? <span className="tabular-nums">{p.stockQty}</span> : <span className="text-ink-muted">Not tracked</span>) },
                {
                  key: "status",
                  header: "Status",
                  cell: (p) =>
                    p.archivedAt ? <Badge tone="gray">Archived</Badge> : p.isAvailable ? <Badge tone="green">Available</Badge> : <Badge tone="amber">Unavailable</Badge>,
                },
                {
                  key: "actions",
                  header: "",
                  align: "right" as const,
                  cell: (p) => (
                    <ProductRowActions
                      portal={portal}
                      businesses={businesses}
                      product={{
                        id: p.id, businessId: p.businessId, name: p.name, description: p.description, kind: p.kind, sku: p.sku,
                        priceMinor: p.priceMinor, taxBps: p.taxBps, discountType: p.discountType, discountValue: p.discountValue,
                        imageFileId: p.imageFileId, imageUrl: p.imageUrl, isAvailable: p.isAvailable, trackInventory: p.trackInventory,
                        stockQty: p.stockQty, categoryId: p.categoryId, archivedAt: p.archivedAt,
                      }}
                    />
                  ),
                },
              ]}
            />
            <Pagination
              base={`/${portal}/products`}
              params={{ q: sp.q, businessId: sp.businessId, categoryId: sp.categoryId, status: sp.status }}
              page={res.data.page}
              pageSize={res.data.pageSize}
              total={res.data.total}
            />
          </>
        )}
      </TableCard>
    </>
  );
}

const CATEGORY_CAP = 200;

export async function CategoriesView({ portal, ctx, searchParams }: { portal: Portal; ctx: Ctx; searchParams: SearchParams }) {
  const sp = await flatParams(searchParams);
  const [res, biz] = await Promise.all([load(() => listCategories(ctx, sp.businessId ? { businessId: sp.businessId } : {})), load(() => businessOptions(ctx, portal))]);
  const businesses = biz.ok ? biz.data : [];
  const showBusiness = portal === "admin" || businesses.length > 1;
  return (
    <>
      <Header portal={portal} active="categories" actions={<NewCategoryButton portal={portal} businesses={businesses} />} />
      {biz.ok && businesses.length === 0 && <div className="mb-4">{noBusinessNote(portal)}</div>}
      <TableCard>
        {showBusiness && <FilterBar filters={[{ name: "businessId", label: "Business", type: "select", options: businesses.map((b) => ({ value: b.id, label: b.name })) }]} />}
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            {res.data.length > CATEGORY_CAP && (
              <div className="p-4 pb-0"><Alert tone="info">Showing the first {CATEGORY_CAP} of {res.data.length} categories. Filter by business to see the rest.</Alert></div>
            )}
            <CategoryTable
              portal={portal}
              rows={res.data.slice(0, CATEGORY_CAP)}
              showBusiness={showBusiness}
              businesses={businesses}
              emptyAction={<NewCategoryButton portal={portal} businesses={businesses} />}
            />
          </>
        )}
      </TableCard>
    </>
  );
}

export async function OffersView({ portal, ctx, searchParams }: { portal: Portal; ctx: Ctx; searchParams: SearchParams }) {
  const sp = await flatParams(searchParams);
  const [res, biz] = await Promise.all([load(() => listOffers(ctx, sp)), load(() => businessOptions(ctx, portal))]);
  const businesses = biz.ok ? biz.data : [];
  const showBusiness = portal === "admin" || businesses.length > 1;
  const filtered = Boolean(sp.q || sp.status || sp.businessId);
  return (
    <>
      <Header portal={portal} active="offers" actions={<NewOfferButton portal={portal} businesses={businesses} />} />
      {biz.ok && businesses.length === 0 && <div className="mb-4">{noBusinessNote(portal)}</div>}
      <TableCard>
        <FilterBar
          filters={[
            { name: "q", label: "Search", type: "search", placeholder: "Title or code" },
            ...(showBusiness ? [{ name: "businessId", label: "Business", type: "select" as const, options: businesses.map((b) => ({ value: b.id, label: b.name })) }] : []),
            { name: "status", label: "Status", type: "select", options: [{ value: "active", label: "Live" }, { value: "inactive", label: "Inactive" }, { value: "expired", label: "Expired" }] },
          ]}
        />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <OfferTable
              portal={portal}
              rows={res.data.items}
              showBusiness={showBusiness}
              businesses={businesses}
              filtered={filtered}
              emptyAction={<NewOfferButton portal={portal} businesses={businesses} />}
            />
            <Pagination
              base={`/${portal}/products/offers`}
              params={{ q: sp.q, businessId: sp.businessId, status: sp.status }}
              page={res.data.page}
              pageSize={res.data.pageSize}
              total={res.data.total}
            />
          </>
        )}
      </TableCard>
    </>
  );
}
