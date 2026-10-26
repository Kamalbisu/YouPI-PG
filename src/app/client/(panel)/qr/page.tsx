import { QrListView } from "@/components/features/qr/qr-views";
import type { SearchParams } from "@/components/features/clients/page-utils";
import { requireClientPage } from "@/server/auth/page-guards";

export const metadata = { title: "QR codes" };

export default async function ClientQrPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx } = await requireClientPage();
  return <QrListView portal="client" ctx={ctx} searchParams={searchParams} />;
}
