import { QrListView } from "@/components/features/qr/qr-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "QR codes" };

export default async function AdminQrPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireAdminPage();
  return <QrListView portal="admin" ctx={ctx} searchParams={searchParams} />;
}
