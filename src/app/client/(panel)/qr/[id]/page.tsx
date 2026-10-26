import { QrDetailView } from "@/components/features/qr/qr-views";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "QR code" };

export default async function ClientQrDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireClientPage();
  const { id } = await params;
  return <QrDetailView portal="client" ctx={ctx} id={id} />;
}
