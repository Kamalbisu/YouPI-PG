import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, Badge, Card, CardBody, CardHeader, DataTable, ErrorState, PageHeader, Pagination, StatusBadge, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { ORDER_STATUS_OPTIONS, methodLabel, providerLabel, type Portal } from "@/components/features/transactions/txn-format";
import { formatMinor } from "@/lib/money";
import { formatDateTime } from "@/lib/utils";
import type { Ctx } from "@/server/auth/types";
import { listMyBusinesses } from "@/server/services/businesses";
import { getOrder, listOrders } from "@/server/services/orders";
import { CancelOrderButton } from "./order-actions";

export async function OrderListView({ portal, ctx, searchParams }: { portal: Portal; ctx: Ctx; searchParams: SearchParams }) {
  const sp = await flatParams(searchParams);
  const [res, biz] = await Promise.all([
    load(() => listOrders(ctx, sp)),
    portal === "client" ? load(() => listMyBusinesses(ctx)) : Promise.resolve(null),
  ]);
  const bizOptions = biz?.ok ? biz.data.map((b) => ({ value: b.id, label: b.name })) : [];
  const showBusiness = portal === "admin" || bizOptions.length > 1;
  const filtered = Boolean(sp.q || sp.status || sp.businessId || sp.from || sp.to);
  const filters = [
    { name: "q", label: "Search", type: "search" as const, placeholder: "Order, customer, phone" },
    ...(showBusiness && bizOptions.length ? [{ name: "businessId", label: "Business", type: "select" as const, options: bizOptions }] : []),
    { name: "status", label: "Status", type: "select" as const, options: ORDER_STATUS_OPTIONS },
    { name: "from", label: "From", type: "date" as const },
    { name: "to", label: "To", type: "date" as const },
  ];

  return (
    <>
      <PageHeader title="Orders" description="Every order created from your QR codes and payment links, paid or not." />
      <TableCard>
        <FilterBar filters={filters} />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(o) => o.id}
              empty={{
                title: filtered ? "No orders match" : "No orders yet",
                description: filtered ? "Try changing or clearing the filters." : "Orders appear here as soon as a customer starts a payment.",
              }}
              columns={[
                { key: "code", header: "Order", cell: (o) => <Link href={`/${portal}/orders/${o.id}`} className="font-medium text-brand-600 hover:underline">{o.orderCode}</Link> },
                { key: "customer", header: "Customer", cell: (o) => <div><p>{o.customerName || "-"}</p>{o.customerPhone && <p className="text-xs text-ink-muted">{o.customerPhone}</p>}</div> },
                ...(showBusiness ? [{ key: "biz", header: "Business", cell: (o: (typeof res.data.items)[number]) => o.business.name }] : []),
                { key: "total", header: "Total", align: "right" as const, cell: (o) => <span className="tabular-nums">{formatMinor(o.totalMinor, o.currency)}</span> },
                { key: "created", header: "Created", cell: (o) => formatDateTime(o.createdAt) },
                { key: "status", header: "Status", cell: (o) => <StatusBadge status={o.status} /> },
              ]}
            />
            <Pagination
              base={`/${portal}/orders`}
              params={{ q: sp.q, businessId: sp.businessId, status: sp.status, from: sp.from, to: sp.to }}
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

export async function OrderDetailView({ portal, ctx, id }: { portal: Portal; ctx: Ctx; id: string }) {
  const res = await load(() => getOrder(ctx, id));
  if (!res.ok) return <ErrorState message={res.error} />;
  const o = res.data;
  const mayCancel = portal === "admin" || Boolean(ctx.actor?.permissions.includes("orders.manage"));
  const canTxn = portal === "admin" || Boolean(ctx.actor?.permissions.includes("payments.view"));

  return (
    <>
      <div className="mb-3">
        <Link href={`/${portal}/orders`} className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />All orders
        </Link>
      </div>
      <PageHeader
        title={`Order ${o.orderCode}`}
        description={`${o.business.name} - created ${formatDateTime(o.createdAt)}`}
        actions={
          <div className="flex items-center gap-3">
            <StatusBadge status={o.status} />
            {o.status === "PENDING_PAYMENT" && mayCancel && <CancelOrderButton portal={portal} orderId={o.id} orderCode={o.orderCode} />}
          </div>
        }
      />
      {o.status === "PENDING_PAYMENT" && <div className="mb-5"><Alert tone="info">Waiting for the customer to pay{o.expiresAt ? `. The order expires on ${formatDateTime(o.expiresAt)}` : ""}.</Alert></div>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Customer" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Detail label="Name" value={o.customerName || "-"} />
              <Detail label="Phone" value={o.customerPhone || "-"} />
              <Detail label="Email" value={o.customerEmail || "-"} />
              <Detail label="Paid" value={o.paidAt ? formatDateTime(o.paidAt) : "-"} />
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Amounts" />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Detail label="Subtotal" value={formatMinor(o.subtotalMinor, o.currency)} />
              <Detail label="Discount" value={formatMinor(o.discountMinor, o.currency)} />
              <Detail label="Tax" value={formatMinor(o.taxMinor, o.currency)} />
              <Detail label="Total" value={formatMinor(o.totalMinor, o.currency)} />
            </dl>
          </CardBody>
        </Card>
      </div>

      <div className="mt-5 space-y-5">
        <Card>
          <CardHeader title="Items" />
          <DataTable
            rows={o.items}
            rowKey={(i) => i.id}
            empty={{ title: "No items" }}
            columns={[
              { key: "name", header: "Item", cell: (i) => i.name },
              { key: "qty", header: "Qty", align: "right", cell: (i) => i.quantity },
              { key: "unit", header: "Unit price", align: "right", cell: (i) => formatMinor(i.unitPriceMinor, o.currency) },
              { key: "total", header: "Total", align: "right", cell: (i) => <span className="tabular-nums">{formatMinor(i.lineTotalMinor, o.currency)}</span> },
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Payment attempts" />
          <DataTable
            rows={o.attempts}
            rowKey={(a) => a.id}
            empty={{ title: "No payment attempts", description: "The customer has not started paying yet." }}
            columns={[
              { key: "date", header: "Started", cell: (a) => formatDateTime(a.createdAt) },
              { key: "provider", header: "Provider", cell: (a) => providerLabel(a.provider) },
              { key: "method", header: "Method", cell: (a) => methodLabel(a.method) },
              { key: "amount", header: "Amount", align: "right", cell: (a) => formatMinor(a.amountMinor, o.currency) },
              { key: "status", header: "Status", cell: (a) => <div><StatusBadge status={a.status} />{a.failureReason && <p className="mt-1 text-xs text-ink-muted">{a.failureReason}</p>}</div> },
            ]}
          />
        </Card>
        {canTxn && (
          <Card>
            <CardHeader title="Verified payments" />
            <DataTable
              rows={o.transactions}
              rowKey={(t) => t.id}
              empty={{ title: "No verified payments", description: "A payment shows here only after the provider confirms it." }}
              columns={[
                { key: "ref", header: "Reference", cell: (t) => <Link href={`/${portal}/transactions/${t.id}`} className="font-medium text-brand-600 hover:underline">{t.txnRef}</Link> },
                { key: "provider", header: "Provider", cell: (t) => providerLabel(t.provider) },
                { key: "amount", header: "Amount", align: "right", cell: (t) => formatMinor(t.amountMinor, o.currency) },
                { key: "refunded", header: "Refunded", align: "right", cell: (t) => formatMinor(t.refundedMinor, o.currency) },
                { key: "status", header: "Status", cell: (t) => (t.isDuplicate ? <Badge tone="amber">Duplicate</Badge> : <StatusBadge status={t.status} />) },
              ]}
            />
          </Card>
        )}
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words">{value}</dd>
    </div>
  );
}
