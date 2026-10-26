import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { getPublicOrder } from "@/server/services/orders";
import { getPaymentOptions } from "@/server/services/checkout";
import { PayClient } from "./pay-client";

export const metadata: Metadata = { title: "Pay", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PayPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  let data;
  try {
    data = await Promise.all([getPublicOrder(publicId), getPaymentOptions(publicId)]);
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const [order, options] = data;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 p-4 sm:py-10">
      <PayClient order={order} options={options} />
    </main>
  );
}
