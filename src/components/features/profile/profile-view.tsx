import { Badge, Card, CardHeader, DataTable, ErrorState, PageHeader } from "@/components/ui";
import { load } from "@/components/features/clients/page-utils";
import { ChangePasswordForm, EditProfileForm, TwoFactorCard } from "@/components/features/profile/profile-forms";
import { formatDateTime } from "@/lib/utils";
import type { Ctx } from "@/server/auth/types";
import { getProfile } from "@/server/services/profile";

/** Shared server-rendered profile and security page for both portals. */
export async function ProfileView({ ctx }: { ctx: Ctx }) {
  const res = await load(() => getProfile(ctx));
  if (!res.ok) return <><PageHeader title="Profile" /><ErrorState message={res.error} /></>;
  const { user, logins } = res.data;
  return (
    <>
      <PageHeader title="Profile and security" description="Manage your details, password and sign-in protection." />
      <div className="space-y-5">
        <EditProfileForm name={user.name} phone={user.phone ?? ""} email={user.email} />
        <ChangePasswordForm />
        <TwoFactorCard enabled={user.totpEnabled} />
        <Card className="overflow-hidden">
          <CardHeader title="Recent sign-ins" description="The last 10 attempts on your account." />
          <DataTable
            rows={logins}
            rowKey={(l) => l.id}
            empty={{ title: "No sign-ins yet" }}
            columns={[
              { key: "t", header: "Time", cell: (l) => <span className="whitespace-nowrap">{formatDateTime(l.createdAt)}</span> },
              { key: "r", header: "Result", cell: (l) => <Badge tone={l.success ? "green" : "red"}>{l.success ? "Success" : "Failed"}</Badge> },
              { key: "ip", header: "IP address", cell: (l) => l.ip ?? "-" },
              { key: "ua", header: "Device", cell: (l) => <span className="block max-w-xs truncate" title={l.userAgent ?? ""}>{l.userAgent ?? "-"}</span> },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
