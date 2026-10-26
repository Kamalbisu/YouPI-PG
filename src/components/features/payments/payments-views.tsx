import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, Badge, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, LinkTabs, PageHeader, Pagination, Stat, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { formatMinor } from "@/lib/money";
import { formatDateTime } from "@/lib/utils";
import type { Ctx } from "@/server/auth/types";
import { listPaymentConfigs, listPaymentOverview } from "@/server/services/payment-config";
import { listReconciliation } from "@/server/services/reconciliation";
import { ProviderPanel } from "./provider-panel";
import { ReconActions } from "./recon-actions";

const TABS = [
  { key: "overview", label: "Providers", href: "/admin/payments" },
  { key: "reconciliation", label: "Reconciliation", href: "/admin/payments/reconciliation" },
];

const PROVIDER_NAME = { RAZORPAY: "Razorpay", CASHFREE: "Cashfree" } as const;

export async function PaymentsOverviewView({ ctx, searchParams }: { ctx: Ctx; searchParams: SearchParams }) {
  const sp = await flatParams(searchParams);
  const res = await load(() => listPaymentOverview(ctx, { q: sp.q, page: sp.page }));
  return (
    <>
      <PageHeader title="Payments" description="Payment provider setup for each business. Credentials are stored encrypted and never shown again." />
      <LinkTabs tabs={TABS} active="overview" />
      <TableCard>
        <FilterBar filters={[{ name: "q", label: "Search", type: "search", placeholder: "Business or client" }]} />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(b) => b.businessId}
              empty={{ title: sp.q ? "No businesses match" : "No businesses yet", description: sp.q ? "Try a different search." : "Add a client and a business before configuring payments." }}
              columns={[
                {
                  key: "biz",
                  header: "Business",
                  cell: (b) => (
                    <div>
                      <Link href={`/admin/payments/${b.businessId}`} className="font-medium text-brand-600 hover:underline">{b.businessName}</Link>
                      <p className="text-xs text-ink-muted">{b.clientName}</p>
                    </div>
                  ),
                },
                ...(["RAZORPAY", "CASHFREE"] as const).map((p) => ({
                  key: p,
                  header: PROVIDER_NAME[p],
                  cell: (b: (typeof res.data.items)[number]) => {
                    const s = b.providers.find((x) => x.provider === p);
                    if (!s) return "-";
                    if (!s.configured) return s.platformFallback ? <Badge tone="amber">Platform credentials</Badge> : <span className="text-ink-muted">Not set up</span>;
                    return (
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={s.isActive ? "green" : "gray"}>{s.isActive ? "Active" : "Inactive"}</Badge>
                        <Badge tone={s.mode === "LIVE" ? "blue" : "gray"}>{s.mode === "LIVE" ? "Live" : "Test"}</Badge>
                        {!s.verified && <Badge tone="amber">Unverified</Badge>}
                      </div>
                    );
                  },
                })),
                { key: "status", header: "Business status", cell: (b) => <Badge tone={b.status === "ACTIVE" ? "green" : "gray"}>{b.status === "ACTIVE" ? "Active" : b.status.toLowerCase()}</Badge> },
              ]}
            />
            <Pagination base="/admin/payments" params={{ q: sp.q }} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} />
          </>
        )}
      </TableCard>
    </>
  );
}

export async function BusinessPaymentsView({ ctx, businessId }: { ctx: Ctx; businessId: string }) {
  const res = await load(() => listPaymentConfigs(ctx, { businessId }));
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Payments" />
        <ErrorState message={res.error} />
      </>
    );
  }
  const { businessName, configs, methodLabels } = res.data;
  const anyActive = configs.some((c) => c.isActive || c.usesPlatformCredentials);
  return (
    <>
      <Link href="/admin/payments" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden />All businesses</Link>
      <PageHeader title={businessName} description="Provider credentials and the payment methods customers can use at checkout." />
      {!anyActive && <Alert tone="warn">No provider is active for this business, so customers cannot pay. Add credentials, verify them and activate a provider.</Alert>}
      <div className="mt-4 space-y-5">
        {configs.map((c) => (
          <ProviderPanel key={c.provider} config={c} methodLabels={methodLabels} />
        ))}
      </div>
    </>
  );
}

export async function ReconciliationView({ ctx, searchParams }: { ctx: Ctx; searchParams: SearchParams }) {
  const sp = await flatParams(searchParams);
  const showReviewed = sp.reviewed === "1";
  const res = await load(() => listReconciliation(ctx, showReviewed ? { includeReviewed: true } : {}));
  return (
    <>
      <PageHeader
        title="Payments"
        description="Cases where money, orders and provider records may disagree."
      />
      <LinkTabs tabs={TABS} active="reconciliation" />
      {!res.ok ? (
        <ErrorState message={res.error} />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Stat label="Open items" value={res.data.openCount} tone={res.data.openCount > 0 ? "warn" : "good"} sub={`Attempts count as stuck after ${res.data.stuckMinutes} minutes`} />
            <Link href={showReviewed ? "/admin/payments/reconciliation" : "/admin/payments/reconciliation?reviewed=1"} className="text-sm font-medium text-brand-600 hover:underline">
              {showReviewed ? "Hide reviewed items" : "Show reviewed items"}
            </Link>
          </div>
          {res.data.sections.every((s) => s.items.length === 0) ? (
            <Card><CardBody><EmptyState title="Nothing to reconcile" description="No stuck attempts, mismatches or failed webhooks right now." /></CardBody></Card>
          ) : (
            res.data.sections.filter((s) => s.items.length > 0).map((s) => (
              <Card key={s.kind}>
                <CardHeader title={s.label} description={s.total > s.items.length ? `Showing ${s.items.length} of ${s.total}` : `${s.total} item${s.total === 1 ? "" : "s"}`} />
                <DataTable
                  rows={s.items}
                  rowKey={(i) => `${i.kind}:${i.id}`}
                  empty={{ title: "None" }}
                  columns={[
                    {
                      key: "what",
                      header: "Item",
                      cell: (i) => (
                        <div>
                          <p className="font-medium">{i.title}{i.reviewed && <Badge tone="gray"> Reviewed</Badge>}</p>
                          <p className="text-xs text-ink-muted">{i.detail}</p>
                          {i.reviewNote && <p className="text-xs text-ink-muted">Note: {i.reviewNote}</p>}
                        </div>
                      ),
                    },
                    { key: "biz", header: "Business", cell: (i) => i.businessName ?? "-" },
                    { key: "amount", header: "Amount", align: "right" as const, cell: (i) => (i.amountMinor === null ? "-" : <span className="tabular-nums">{formatMinor(i.amountMinor, i.currency ?? "INR")}</span>) },
                    { key: "at", header: "When", cell: (i) => formatDateTime(i.at) },
                    {
                      key: "actions",
                      header: "",
                      cell: (i) => (i.reviewed ? null : <ReconActions kind={i.kind} id={i.id} orderId={i.orderId} canRefetch={i.kind !== "FAILED_WEBHOOK" || Boolean(i.orderId)} />),
                    },
                  ]}
                />
              </Card>
            ))
          )}
        </div>
      )}
    </>
  );
}
