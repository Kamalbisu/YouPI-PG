import { PageHeader } from "@/components/ui";
import { CreateClientForm } from "@/components/features/clients/client-forms";
import { CLIENT_PERMISSIONS } from "@/lib/permissions";
import { requireAdminPage } from "@/server/auth/page-guards";
import { getSetting } from "@/server/services/settings";

export const metadata = { title: "New client" };

export default async function NewClientPage() {
  await requireAdminPage();
  const defaults = await getSetting("defaultClientPermissions");
  const options = Object.entries(CLIENT_PERMISSIONS).map(([key, label]) => ({ key, label: String(label) }));
  return (
    <>
      <PageHeader title="New client" description="Creates the client account and sends a set-password invitation. No password is ever emailed." />
      <CreateClientForm permissionOptions={options} defaultPermissions={defaults} />
    </>
  );
}
