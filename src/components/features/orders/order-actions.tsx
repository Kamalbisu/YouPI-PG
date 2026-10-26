"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { api } from "@/components/shared/use-api";

type Portal = "admin" | "client";

/** Cancels an unpaid order. The server rejects it if the order was paid in the meantime. */
export function CancelOrderButton({ portal, orderId, orderCode }: { portal: Portal; orderId: string; orderCode: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Ban className="size-4" aria-hidden />Cancel order</Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Cancel order ${orderCode}?`}
        description="The customer will no longer be able to pay for this order. This cannot be undone."
        confirmLabel="Cancel order"
        danger
        onConfirm={async () => {
          await api(`/api/${portal}/orders/${orderId}/cancel`, { method: "POST" });
          toast.success("Order cancelled");
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
