import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, Badge, Card, CardBody, CardHeader, DataTable, ErrorState, PageHeader, Pagination, Stat, StatusBadge, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { formatMinor } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { Ctx } from "@/server/auth/types";
import { listBusinesses, listMyBusinesses } from "@/server/services/businesses";
import { listClients } from "@/server/services/clients";
import { getTransaction, listTransactions, transactionTotals } from "@/server/services/transactions";
import { RefundButton } from "./refund-button";
import { METHOD_OPTIONS, PROVIDER_OPTIONS, TXN_STATUS_OPTIONS, methodLabel, providerLabel, type Portal } from "./txn-format";

async function businessOptions(ctx: Ctx, portal: Portal) {
  if (portal === "admin") {
    const page = await listBusinesses(ctx, { pageSize: 100 });
    return page.items.map((b) => ({ value: b.id, label: `${b.name} (${b.client.name})` }));
  }
  const rows = await listMyBusinesses(ctx);
  return rows.map((b) => ({ value: b.id, label: b.name }));
}

const canRefund = (portal: Portal, ctx: Ctx) => portal === "admin" || Boolean(ctx.actor?.permissions.includes("payments.refund"));
const canExport = (portal: Portal, ctx: Ctx) => portal === "admin" || Boolean(ctx.actor?.permissions.includes("reports.export"));

export async function TransactionListView({ portal, ctx, searchParams }: { portal: Portal; ctx: Ctx; searchParams: SearchParams }) {
  const sp = await flatParams(searchParams);
  const [res, totals, biz, clients] = await Promise.all([
    load(() => listTransactions(ctx, sp)),
    load(() => transactionTotals(ctx, sp)),
    load(() => businessOptions(ctx, portal)),
    portal === "admin" ? load(() => listClients(ctx, { pageSize: 100 })) : Promise.resolve(null),
  ]);
  const bizOptions = biz.ok ? biz.data : [];
  const showBusiness = portal === "admin" || bizOptions.length > 1;
  const filtered = Boolean(sp.q || sp.status || sp.provider || sp.method || sp.businessId || sp.clientId || sp.from || sp.to);

  const filters = [
    { name: "q", label: "Search", type: "search" as const, placeholder: "Reference, customer, order" },
    ...(portal === "admin" && clients?.ok ? [{ name: "clientId", label: "Client", type: "select" as const, options: clients.data.items.map((c) => ({ value: c.id, label: c.name })) }] : []),
    ...(showBusiness ? [{ name: "businessId", label: "Business", type: "select" as const, options: bizOptions }] : []),
    { name: "status", label: "Status", type: "select" as const, options: TXN_STATUS_OPTIONS },
    { name: "provider", label: "Provider", type: "select" as const, options: PROVIDER_OPTIONS },
    { name: "method", label: "Method", type: "select" as const, options: METHOD_OPTIONS },
    { name: "from", label: "From", type: "date" as const },
    { name: "to", label: "To", type: "date" as const },
  ];

  return (
    <>
      <PageHeader title="Transactions" description="Verified payments only. Unconfirmed attempts never appear here." />
      {totals.ok && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Payments" value={totals.data.count} sub="Matching the filters" />
          <Stat label="Gross" value={formatMinor(totals.data.grossMinor)} />
          <Stat label="Refunded" value={formatMinor(totals.data.refundedMinor)} tone={totals.data.refundedMinor > 0 ? "warn" : "default"} />
          <Stat label="Net" value={formatMinor(totals.data.netMinor)} sub={`After ${formatMinor(totals.data.feeMinor)} fees`} tone="good" />
        </div>
      )}
      <TableCard>
        <FilterBar filters={filters} exportHref={canExport(portal, ctx) ? `/api/${portal}/transactions/export` : undefined} />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(t) => t.id}
              empty={{
                title: filtered ? "No transactions match" : "No transactions yet",
                description: filtered ? "Try changing or clearing the filters." : "Payments appear here once customers pay and the provider confirms it.",
              }}
              columns={[
                {
                  key: "ref",
                  header: "Reference",
                  cell: (t) => (
                    <div>
                      <Link href={`/${portal}/transactions/${t.id}`} className="font-medium text-brand-600 hover:underline">{t.txnRef}</Link>
                      <p className="text-xs text-ink-muted">{t.order.orderCode}{t.isDuplicate ? " - duplicate" : ""}</p>
                    </div>
                  ),
                },
                { key: "customer", header: "Customer", cell: (t) => t.order.customerName || "-" },
                ...(showBusiness
                  ? [{
                      key: "biz",
                      header: portal === "admin" ? "Business / client" : "Business",
                      cell: (t: (typeof res.data.items)[number]) => (
                        <div>
                          <p>{t.order.business.name}</p>
                          {portal === "admin" && <p className="text-xs text-ink-muted">{t.order.business.client.name}</p>}
                        </div>
                      ),
                    }]
                  : []),
                { key: "method", header: "Method", cell: (t) => <div><p>{methodLabel(t.method)}</p><p className="text-xs text-ink-muted">{providerLabel(t.provider)}</p></div> },
                { key: "amount", header: "Amount", align: "right" as const, cell: (t) => <span className="tabular-nums">{formatMinor(t.amountMinor, t.currency)}</span> },
                { key: "net", header: "Net", align: "right" as const, cell: (t) => <span className="tabular-nums">{formatMinor(t.netMinor, t.currency)}</span> },
                { key: "date", header: "Paid", cell: (t) => (t.verifiedAt ? formatDateTime(t.verifiedAt) : "-") },
                { key: "status", header: "Status", cell: (t) => (t.isDuplicate ? <Badge tone="amber">Duplicate</Badge> : <StatusBadge status={t.status} />) },
              ]}
            />
            <Pagination
              base={`/${portal}/transactions`}
              params={{ q: sp.q, clientId: sp.clientId, businessId: sp.businessId, status: sp.status, provider: sp.provider, method: sp.method, from: sp.from, to: sp.to }}
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

export async function TransactionDetailView({ portal, ctx, id }: { portal: Portal; ctx: Ctx; id: string }) {
  const res = await load(() => getTransaction(ctx, id));
  if (!res.ok) return <ErrorState message={res.error} />;
  const t = res.data;
  const backHref = `/${portal}/transactions`;
  const refundable = !t.isDuplicate && canRefund(portal, ctx) ? t.refundableMinor : 0;

  return (
    <>
      <div className="mb-3">
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />All transactions
        </Link>
      </div>
      <PageHeader
        title={t.txnRef}
        description={`${t.order.business.name} - order ${t.order.orderCode}`}
        actions={
          <div className="flex items-center gap-3">
            {t.isDuplicate ? <Badge tone="amber">Duplicate</Badge> : <StatusBadge status={t.status} />}
            <RefundButton portal={portal} transactionId={t.id} refundableMinor={refundable} currency={t.currency} />
          </div>
        }
      />
      {t.isDuplicate && <div className="mb-5"><Alert tone="warn">This is a repeat payment for an order that was already settled or closed. It is excluded from totals; refund it if the customer was charged twice.</Alert></div>}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Amount paid" value={formatMinor(t.amountMinor, t.currency)} />
        <Stat label="Refunded" value={formatMinor(t.refundedMinor, t.currency)} tone={t.refundedMinor > 0 ? "warn" : "default"} />
        <Stat label="Provider fees" value={formatMinor(t.feeTotalMinor, t.currency)} sub={(t.feeTaxMinor ?? 0) > 0 ? `Includes ${formatMinor(t.feeTaxMinor ?? 0, t.currency)} tax` : undefined} />
        <Stat label="Net" value={formatMinor(t.netMinor, t.currency)} tone="good" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Payment" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Detail label="Provider" value={providerLabel(t.provider)} />
              <Detail label="Method" value={methodLabel(t.method)} />
              <Detail label="Provider payment id" value={t.providerPaymentId ?? "-"} mono />
              <Detail label="Verified" value={t.verifiedAt ? formatDateTime(t.verifiedAt) : "-"} />
              <Detail label="Verified by" value={t.verificationSource.toLowerCase().replace(/_/g, " ")} />
              <Detail label="Recorded" value={formatDateTime(t.createdAt)} />
              {portal === "admin" && <Detail label="Client" value={t.order.business.client.name} />}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Order and customer" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Detail label="Order" value={t.order.orderCode} />
              <Detail label="Order status" value={t.order.status.toLowerCase().replace(/_/g, " ")} />
              <Detail label="Customer" value={t.order.customerName || "-"} />
              <Detail label="Phone" value={t.order.customerPhone || "-"} />
              <Detail label="Email" value={t.order.customerEmail || "-"} />
              <Detail label="Order total" value={formatMinor(t.order.totalMinor, t.currency)} />
            </dl>
            {portal === "client" && (
              <p className="mt-4 text-sm">
                <Link href={`/client/orders/${t.order.id}`} className="font-medium text-brand-600 hover:underline">View order</Link>
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-5 space-y-5">
        <Card>
          <CardHeader title="Items" />
          <DataTable
            rows={t.order.items}
            rowKey={(i) => i.id}
            empty={{ title: "No items" }}
            columns={[
              { key: "name", header: "Item", cell: (i) => i.name },
              { key: "qty", header: "Qty", align: "right", cell: (i) => i.quantity },
              { key: "unit", header: "Unit price", align: "right", cell: (i) => formatMinor(i.unitPriceMinor, t.currency) },
              { key: "tax", header: "Tax", align: "right", cell: (i) => formatMinor(i.taxMinor, t.currency) },
              { key: "total", header: "Total", align: "right", cell: (i) => <span className="tabular-nums">{formatMinor(i.lineTotalMinor, t.currency)}</span> },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Refunds" />
          <DataTable
            rows={t.refunds}
            rowKey={(r) => r.id}
            empty={{ title: "No refunds", description: "Refunds issued for this payment appear here." }}
            columns={[
              { key: "ref", header: "Reference", cell: (r) => r.refundRef },
              { key: "amount", header: "Amount", align: "right", cell: (r) => formatMinor(r.amountMinor, t.currency) },
              { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
              { key: "reason", header: "Reason", cell: (r) => <span>{r.reason}{r.failureReason ? ` (${r.failureReason})` : ""}</span> },
              { key: "date", header: "Requested", cell: (r) => formatDate(r.createdAt) },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Attempt history" />
          <CardBody>
            {t.attempt.history.length === 0 ? (
              <p className="text-sm text-ink-muted">No status changes recorded.</p>
            ) : (
              <ol className="space-y-3 text-sm">
                {t.attempt.history.map((h, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="w-44 shrink-0 text-xs text-ink-muted">{formatDateTime(h.createdAt)}</span>
                    <span>{h.fromStatus ? `${h.fromStatus.toLowerCase().replace(/_/g, " ")} to ` : ""}<strong className="font-medium">{h.toStatus.toLowerCase().replace(/_/g, " ")}</strong></span>
                    <span className="text-xs text-ink-muted">via {h.source.toLowerCase().replace(/_/g, " ")}{h.note ? ` - ${h.note}` : ""}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className={mono ? "mt-0.5 break-all font-mono text-xs" : "mt-0.5"}>{value}</dd>
    </div>
  );
}
