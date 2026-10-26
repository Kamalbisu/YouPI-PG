import Link from "next/link";
import { Alert, Badge, Card, CardBody, CardHeader, DataTable, ErrorState, LinkTabs, PageHeader, Pagination, StatusBadge, TableCard } from "@/components/ui";
import { ClientStatusActions, ResetPasswordButton } from "@/components/features/clients/client-actions";
import { EditClientForm, PermissionsEditor } from "@/components/features/clients/client-forms";
import { flatParams, load, type SearchParams } from "@/components/features/clients/page-utils";
import { CLIENT_PERMISSIONS } from "@/lib/permissions";
import { formatDateTime } from "@/lib/utils";
import { requireAdminPage } from "@/server/auth/page-guards";
import { clientLoginActivity, getClient } from "@/server/services/clients";

export const metadata = { title: "Client" };

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "businesses", label: "Businesses" },
  { key: "users", label: "Users" },
  { key: "activity", label: "Login activity" },
  { key: "permissions", label: "Permissions" },
];

export default async function ClientDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  const { id } = await params;
  const sp = await flatParams(searchParams);
  const tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as string) : "overview";
  const res = await load(() => getClient(ctx, id));
  if (!res.ok) return <ErrorState message={res.error} />;
  const { client, users, businesses, suspension } = res.data;
  const options = Object.entries(CLIENT_PERMISSIONS).map(([key, label]) => ({ key, label: String(label) }));

  return (
    <>
      <PageHeader
        title={client.name}
        description={`${client.clientCode} - ${client.email}`}
        actions={
          <>
            <StatusBadge status={client.status} />
            <ResetPasswordButton clientId={client.id} users={users.map((u) => ({ id: u.id, email: u.email, status: u.status }))} />
            <ClientStatusActions clientId={client.id} status={client.status} />
          </>
        }
      />
      {client.status !== "ACTIVE" && (
        <div className="mb-5">
          <Alert tone="warn">
            This client is {client.status.toLowerCase()}; its users cannot sign in.
            {suspension?.reason ? ` Reason: ${suspension.reason}.` : ""}
            {suspension ? ` Since ${formatDateTime(suspension.at)}.` : ""}
          </Alert>
        </div>
      )}
      <LinkTabs active={tab} tabs={TABS.map((t) => ({ ...t, href: `/admin/clients/${client.id}?tab=${t.key}` }))} />

      {tab === "overview" && (
        <div className="space-y-5">
          <EditClientForm client={client} />
          <Card>
            <CardHeader title="Account" />
            <CardBody>
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div><dt className="text-ink-muted">Sign-in email</dt><dd>{client.email}</dd></div>
                <div><dt className="text-ink-muted">Businesses</dt><dd>{businesses.length} of {client.maxBusinesses}</dd></div>
                <div><dt className="text-ink-muted">Created</dt><dd>{formatDateTime(client.createdAt)}</dd></div>
              </dl>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === "businesses" && (
        <TableCard>
          <DataTable
            rows={businesses}
            rowKey={(b) => b.id}
            empty={{ title: "No businesses yet", description: "The client has not created a business." }}
            columns={[
              { key: "name", header: "Business", cell: (b) => (<div><Link href={`/admin/businesses/${b.id}`} className="font-medium text-brand-600 hover:underline">{b.name}</Link><p className="text-xs text-ink-muted">{b.businessCode}</p></div>) },
              { key: "cat", header: "Category", cell: (b) => b.category ?? "-" },
              { key: "status", header: "Status", cell: (b) => <StatusBadge status={b.status} /> },
              { key: "created", header: "Created", cell: (b) => formatDateTime(b.createdAt) },
            ]}
          />
        </TableCard>
      )}

      {tab === "users" && (
        <TableCard>
          <DataTable
            rows={users}
            rowKey={(u) => u.id}
            empty={{ title: "No users" }}
            columns={[
              { key: "name", header: "User", cell: (u) => (<div><p className="font-medium">{u.name}</p><p className="text-xs text-ink-muted">{u.email}</p></div>) },
              { key: "biz", header: "Access", cell: (u) => (u.memberships.length ? u.memberships.map((m) => `${m.business.name} (${m.role.toLowerCase()})`).join(", ") : "-") },
              { key: "2fa", header: "2FA", cell: (u) => (u.totpEnabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>) },
              { key: "status", header: "Status", cell: (u) => <StatusBadge status={u.status} /> },
              { key: "last", header: "Last sign-in", cell: (u) => formatDateTime(u.lastLoginAt) },
            ]}
          />
        </TableCard>
      )}

      {tab === "activity" && <Activity ctx={ctx} clientId={client.id} page={sp.page} />}

      {tab === "permissions" && <PermissionsEditor clientId={client.id} options={options} initial={client.permissions} />}
    </>
  );
}

async function Activity({ ctx, clientId, page }: { ctx: Awaited<ReturnType<typeof requireAdminPage>>["ctx"]; clientId: string; page?: string }) {
  const res = await load(() => clientLoginActivity(ctx, clientId, { page }));
  if (!res.ok) return <ErrorState message={res.error} />;
  return (
    <TableCard>
      <DataTable
        rows={res.data.items}
        rowKey={(e) => e.id}
        empty={{ title: "No sign-in activity yet" }}
        columns={[
          { key: "time", header: "Time", cell: (e) => formatDateTime(e.createdAt) },
          { key: "email", header: "Email", cell: (e) => e.email },
          { key: "result", header: "Result", cell: (e) => (e.success ? <Badge tone="green">Success</Badge> : <Badge tone="red">{e.reason ?? "Failed"}</Badge>) },
          { key: "ip", header: "IP address", cell: (e) => e.ip ?? "-" },
          { key: "ua", header: "Device", className: "max-w-[16rem] truncate", cell: (e) => <span title={e.userAgent ?? ""}>{e.userAgent ?? "-"}</span> },
        ]}
      />
      <Pagination base={`/admin/clients/${clientId}`} params={{ tab: "activity" }} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} />
    </TableCard>
  );
}
