import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, PageHeader, Pagination, StatusBadge, TableCard } from "@/components/ui";
import { FilterBar } from "@/components/shared/filter-bar";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listUsers } from "@/server/services/users";

export const metadata: Metadata = { title: "Users" };
type SP = Promise<Record<string, string | undefined>>;

export default async function UsersPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireAdminPage();
  const sp = await searchParams;
  const r = await listUsers(ctx, sp);
  return (
    <>
      <PageHeader title="Users" description={`${r.total} user${r.total === 1 ? "" : "s"}`} />
      <TableCard>
        <FilterBar filters={[
          { name: "q", label: "Search", type: "search", placeholder: "Name, username, email or mobile" },
          { name: "status", label: "Status", type: "select", options: [{ value: "ACTIVE", label: "Active" }, { value: "DISABLED", label: "Disabled" }] },
        ]} />
        <DataTable
          rows={r.items}
          rowKey={(u) => u.id}
          empty={{ title: "No users found" }}
          columns={[
            { key: "name", header: "Name", cell: (u) => <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">{u.name}</Link> },
            { key: "username", header: "Username", cell: (u) => `@${u.username}` },
            { key: "email", header: "Email", cell: (u) => u.email ?? "-" },
            { key: "mobile", header: "Mobile", cell: (u) => u.mobile ?? "-" },
            { key: "status", header: "Status", cell: (u) => <StatusBadge status={u.status} /> },
            { key: "txn", header: "Transactions", align: "right", cell: (u) => u._count.transactions },
            { key: "joined", header: "Signed up", cell: (u) => u.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium" }) },
            { key: "last", header: "Last login", cell: (u) => u.lastLoginAt ? u.lastLoginAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Never" },
          ]}
        />
        <Pagination base="/admin/users" params={{ q: sp.q, status: sp.status }} page={r.page} pageSize={r.pageSize} total={r.total} />
      </TableCard>
    </>
  );
}
