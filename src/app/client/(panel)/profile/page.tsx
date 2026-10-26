import { ProfileView } from "@/components/features/profile/profile-view";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "Profile" };

export default async function ProfilePage() {
  const { ctx } = await requireClientPage();
  return <ProfileView ctx={ctx} />;
}
