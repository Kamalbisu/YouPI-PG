import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { QrManager } from "@/components/admin/qr-manager";
import { requireAdminPage } from "@/server/auth/page-guards";
import { listQrsAdmin } from "@/server/services/qr";

export const metadata: Metadata = { title: "QR codes" };

export default async function QrPage() {
  await requireAdminPage();
  const qrs = await listQrsAdmin();
  return (
    <>
      <PageHeader title="QR codes" description="Upload QR images and choose who sees them" />
      <QrManager
        qrs={qrs.map((q) => ({
          id: q.id, label: q.label, amountPaise: q.amountPaise, active: q.active, forAll: q.forAll,
          transactions: q._count.transactions,
          assignments: q.assignments.map((a) => a.user),
        }))}
      />
    </>
  );
}
