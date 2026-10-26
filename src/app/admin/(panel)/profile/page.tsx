import { ProfileView } from "@/components/features/profile/profile-view";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "Profile" };

export default async function ProfilePage() {
  const { ctx } = await requireAdminPage();
  return <ProfileView ctx={ctx} />;
}
