import { ErrorState, PageHeader } from "@/components/ui";
import { load } from "@/components/features/clients/page-utils";
import { ClientSettingsForm, GeneralSettingsForm, OperationsSettingsForm } from "@/components/features/settings/settings-form";
import { CLIENT_PERMISSIONS } from "@/lib/permissions";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listSettings } from "@/server/services/settings";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { ctx } = await requireAdminPage();
  const res = await load(() => listSettings(ctx));
  const perms = Object.entries(CLIENT_PERMISSIONS).map(([key, description]) => ({ key, description: String(description) }));
  return (
    <>
      <PageHeader title="Settings" description="Platform-wide configuration. Each group saves on its own and is recorded in the audit log." />
      {!res.ok ? (
        <ErrorState message={res.error} />
      ) : (
        <div className="space-y-5">
          <GeneralSettingsForm initial={res.data} />
          <ClientSettingsForm initial={res.data} permissions={perms} />
          <OperationsSettingsForm initial={res.data} />
        </div>
      )}
    </>
  );
}
