import Link from "next/link";
import { ArrowLeft, QrCode } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, DataTable, ErrorState, PageHeader, Pagination, Stat, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { formatMinor } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { Ctx } from "@/server/auth/types";
import { listBusinesses, listMyBusinesses } from "@/server/services/businesses";
import { listClients } from "@/server/services/clients";
import { getQr, listQr } from "@/server/services/qr";
import { CopyUrlButton, QrDownloadButtons, QrManageActions } from "./qr-actions";
import { NewQrButton } from "./qr-create";
import { QR_STATE_LABEL, QR_STATE_TONE, QR_TYPE_LABEL, qrState, type BusinessOption, type Portal, type QrType } from "./qr-format";
import { ScanChart } from "./scan-chart";

async function businessOptions(ctx: Ctx, portal: Portal, status?: "ACTIVE"): Promise<BusinessOption[]> {
  if (portal === "admin") {
    const page = await listBusinesses(ctx, { ...(status ? { status } : {}), pageSize: 100 });
    return page.items.map((b) => ({ id: b.id, name: `${b.name} (${b.client.name})` }));
  }
  const rows = await listMyBusinesses(ctx);
  return rows.filter((b) => !status || b.status === status).map((b) => ({ id: b.id, name: b.name }));
}

export async function QrListView({ portal, ctx, searchParams }: { portal: Portal; ctx: Ctx; searchParams: SearchParams }) {
  const sp = await flatParams(searchParams);
  const [res, allBiz, activeBiz, clients] = await Promise.all([
    load(() => listQr(ctx, sp)),
    load(() => businessOptions(ctx, portal)),
    load(() => businessOptions(ctx, portal, "ACTIVE")),
    portal === "admin" ? load(() => listClients(ctx, { pageSize: 100 })) : Promise.resolve(null),
  ]);
  const filterBiz = allBiz.ok ? allBiz.data : [];
  const createBiz = activeBiz.ok ? activeBiz.data : [];
  const showBusiness = portal === "admin" || filterBiz.length > 1;
  const filtered = Boolean(sp.q || sp.status || sp.type || sp.businessId || sp.clientId);

  const filters = [
    { name: "q", label: "Search", type: "search" as const, placeholder: "Label" },
    ...(portal === "admin" && clients?.ok
      ? [{ name: "clientId", label: "Client", type: "select" as const, options: clients.data.items.map((c) => ({ value: c.id, label: c.name })) }]
      : []),
    ...(showBusiness ? [{ name: "businessId", label: "Business", type: "select" as const, options: filterBiz.map((b) => ({ value: b.id, label: b.name })) }] : []),
    { name: "type", label: "Type", type: "select" as const, options: (Object.keys(QR_TYPE_LABEL) as QrType[]).map((t) => ({ value: t, label: QR_TYPE_LABEL[t] })) },
    { name: "status", label: "Status", type: "select" as const, options: [{ value: "active", label: "Active" }, { value: "revoked", label: "Revoked" }, { value: "expired", label: "Expired" }] },
  ];

  return (
    <>
      <PageHeader
        title="QR codes"
        description={portal === "admin" ? "Every QR code across all businesses. Open one to download or revoke it." : "Codes your customers scan to pay you."}
        actions={<NewQrButton portal={portal} businesses={createBiz} />}
      />
      {activeBiz.ok && createBiz.length === 0 && (
        <div className="mb-4">
          <Alert tone="info">{portal === "admin" ? "There are no active businesses yet." : "You need an active business before you can create QR codes. Businesses become active once they are approved."}</Alert>
        </div>
      )}
      <TableCard>
        <FilterBar filters={filters} />
        {!res.ok ? (
          <ErrorState message={res.error} />
        ) : (
          <>
            <DataTable
              rows={res.data.items}
              rowKey={(q) => q.id}
              empty={{
                title: filtered ? "No QR codes match" : "No QR codes yet",
                description: filtered ? "Try changing or clearing the filters." : "Create a QR code so customers can scan and pay.",
                action: filtered ? undefined : <NewQrButton portal={portal} businesses={createBiz} />,
              }}
              columns={[
                {
                  key: "label",
                  header: "QR code",
                  cell: (q) => (
                    <Link href={`/${portal}/qr/${q.id}`} className="flex items-center gap-3 font-medium text-brand-600 hover:underline">
                      <QrCode className="size-5 shrink-0 text-ink-muted" aria-hidden />
                      <span className="truncate">{q.label}</span>
                    </Link>
                  ),
                },
                { key: "type", header: "Type", cell: (q) => QR_TYPE_LABEL[q.type as QrType] + (q.product ? ` / ${q.product.name}` : "") },
                ...(showBusiness
                  ? [{
                      key: "biz",
                      header: portal === "admin" ? "Business / client" : "Business",
                      cell: (q: (typeof res.data.items)[number]) => (
                        <div>
                          <p>{q.business.name}</p>
                          {portal === "admin" && <p className="text-xs text-ink-muted">{q.business.client.name}</p>}
                        </div>
                      ),
                    }]
                  : []),
                { key: "scans", header: "Scans", align: "right" as const, cell: (q) => <span className="tabular-nums">{q.scanCount}</span> },
                { key: "created", header: "Created", cell: (q) => formatDate(q.createdAt) },
                {
                  key: "status",
                  header: "Status",
                  cell: (q) => {
                    const s = qrState(q);
                    return <Badge tone={QR_STATE_TONE[s]}>{QR_STATE_LABEL[s]}</Badge>;
                  },
                },
              ]}
            />
            <Pagination
              base={`/${portal}/qr`}
              params={{ q: sp.q, clientId: sp.clientId, businessId: sp.businessId, type: sp.type, status: sp.status }}
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

function amountRule(q: { type: string; fixedAmountMinor: number | null; allowCustomAmount: boolean; minAmountMinor: number | null; maxAmountMinor: number | null }): string | null {
  if (q.type !== "DYNAMIC_PAYMENT") return null;
  if (q.fixedAmountMinor !== null) return `Fixed ${formatMinor(q.fixedAmountMinor)}`;
  const parts = ["Customer enters the amount"];
  if (q.minAmountMinor !== null) parts.push(`min ${formatMinor(q.minAmountMinor)}`);
  if (q.maxAmountMinor !== null) parts.push(`max ${formatMinor(q.maxAmountMinor)}`);
  return parts.join(", ");
}

export async function QrDetailView({ portal, ctx, id }: { portal: Portal; ctx: Ctx; id: string }) {
  const res = await load(() => getQr(ctx, { id }));
  if (!res.ok) return <ErrorState message={res.error} />;
  const q = res.data;
  const state = qrState(q);
  const rule = amountRule(q);
  const usable = state === "active";
  const backHref = `/${portal}/qr`;

  return (
    <>
      <div className="mb-3">
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />All QR codes
        </Link>
      </div>
      <PageHeader
        title={q.label}
        description={`${QR_TYPE_LABEL[q.type as QrType]} QR code`}
        actions={<Badge tone={QR_STATE_TONE[state]}>{QR_STATE_LABEL[state]}</Badge>}
      />
      {state === "revoked" && (
        <div className="mb-5">
          <Alert tone="warn">
            This QR code was revoked{q.revokedAt ? ` on ${formatDate(q.revokedAt)}` : ""}.{q.revokedReason ? ` Reason: ${q.revokedReason}.` : ""}
            {q.replacement && (
              <> A replacement was issued: <Link href={`${backHref}/${q.replacement.id}`} className="font-medium underline">{q.replacement.label}</Link>.</>
            )}
          </Alert>
        </div>
      )}
      {state === "expired" && <div className="mb-5"><Alert tone="warn">This QR code expired on {formatDate(q.expiresAt!)}. Customers who scan it cannot pay.</Alert></div>}

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader title="Preview" />
          <CardBody className="space-y-4">
            <div className="flex justify-center rounded-lg border border-line bg-white p-3">
              {usable ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/${portal}/qr/${q.id}/png`} alt={`QR code for ${q.label}`} width={256} height={256} className="size-56 max-w-full" />
              ) : (
                <div className="flex size-56 items-center justify-center px-6 text-center text-sm text-ink-muted">This code no longer works, so no image is shown.</div>
              )}
            </div>
            <QrDownloadButtons portal={portal} id={q.id} disabled={!usable} />
            <div>
              <p className="break-all text-xs text-ink-muted">{q.url}</p>
              <div className="mt-2"><CopyUrlButton url={q.url} /></div>
            </div>
            <QrManageActions portal={portal} id={q.id} type={q.type as QrType} revoked={q.status === "REVOKED"} replaced={Boolean(q.replacedById)} />
          </CardBody>
        </Card>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Scans" value={q.stats.scanCount} sub={q.stats.lastScannedAt ? `Last ${formatDateTime(q.stats.lastScannedAt)}` : "Not scanned yet"} />
            <Stat label="Orders" value={q.stats.ordersCount} />
            <Stat label="Paid" value={q.stats.paidTransactions} sub="Verified payments" />
            <Stat label="Net revenue" value={formatMinor(q.stats.netRevenueMinor)} sub={q.stats.refundedMinor > 0 ? `${formatMinor(q.stats.refundedMinor)} refunded` : undefined} tone="good" />
          </div>
          <Card>
            <CardHeader title="Scans, last 30 days" />
            <CardBody><ScanChart data={q.stats.scansByDay} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <Detail label="Business" value={q.business.name} />
                {portal === "admin" && <Detail label="Client" value={q.business.client.name} />}
                {q.product && <Detail label="Product" value={q.product.name} />}
                {rule && <Detail label="Amount" value={rule} />}
                <Detail label="Created" value={formatDateTime(q.createdAt)} />
                <Detail label="Expires" value={q.expiresAt ? formatDate(q.expiresAt) : "Never"} />
              </dl>
            </CardBody>
          </Card>
          {portal === "admin" && (
            <p className="text-xs text-ink-muted">
              <ButtonLink href={`/admin/businesses/${q.business.id}`} variant="ghost" size="sm">View business</ButtonLink>
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
