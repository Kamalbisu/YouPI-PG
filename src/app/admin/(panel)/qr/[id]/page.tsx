import { QrDetailView } from "@/components/features/qr/qr-views";
import { requireAdminPage } from "@/server/auth/page-guards";

export const metadata = { title: "QR code" };

export default async function AdminQrDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAdminPage();
  const { id } = await params;
  return <QrDetailView portal="admin" ctx={ctx} id={id} />;
}
