"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Undo2 } from "lucide-react";
import { Alert, Button, Dialog, Input, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

/** Ask the gateway about every PENDING payment. */
export function ReconcileAllButton() {
  const router = useRouter();
  const toast = useToast();
  const act = useAction(async () => {
    const r = await api<{ checked: number; updated: number; errors: number }>("/api/admin/payments/reconcile", { method: "POST", body: {} });
    toast.success(`Checked ${r.checked}, updated ${r.updated}${r.errors ? `, ${r.errors} could not be checked` : ""}`);
    router.refresh();
  });
  return <Button variant="outline" loading={act.pending} onClick={() => void act.run()}><RefreshCw className="size-4" />Check pending payments</Button>;
}

/** Ask the gateway about one payment. */
export function ReconcileButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const act = useAction(async () => {
    const r = await api<{ status: string; result: string }>(`/api/admin/payments/${id}/reconcile`, { method: "POST", body: {} });
    toast.success(r.result === "unknown" ? "The gateway has no clear answer yet" : `Status is now ${r.status.toLowerCase().replace(/_/g, " ")}`);
    router.refresh();
  });
  return (
    <>
      <Button variant="outline" loading={act.pending} onClick={() => void act.run()}><RefreshCw className="size-4" />Check with gateway</Button>
      {act.error && <span className="text-sm text-red-600">{act.error}</span>}
    </>
  );
}

export function RefundButton({ id, txnId, refundableRupees }: { id: string; txnId: string; refundableRupees: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const act = useAction(async () => {
    const r = await api<{ outcome: string }>(`/api/admin/payments/${id}/refund`, { method: "POST", body: { amount: amount || undefined, reason: reason || undefined } });
    toast.success(r.outcome === "rejected" ? "The gateway rejected the refund" : "Refund sent to the gateway");
    setOpen(false);
    setAmount("");
    setReason("");
    router.refresh();
  });
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}><Undo2 className="size-4" />Refund</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Refund payment" description={`${txnId}: up to ₹${refundableRupees} can still be refunded. Leave the amount blank to refund all of it.`}>
        <form onSubmit={(e) => { e.preventDefault(); void act.run(); }} className="space-y-4">
          {act.error && <Alert tone="error">{act.error}</Alert>}
          <Input label="Amount (₹)" inputMode="decimal" placeholder={refundableRupees} value={amount} onChange={(e) => setAmount(e.target.value)} error={act.fieldErrors.amount} />
          <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} error={act.fieldErrors.reason} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={act.pending}>Refund</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** Re-send a refund that is still queued (the gateway never answered). */
export function RetryRefundButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const act = useAction(async () => {
    await api(`/api/admin/refunds/${id}/retry`, { method: "POST", body: {} });
    toast.success("Refund sent again");
    router.refresh();
  });
  return (
    <>
      <Button size="sm" variant="outline" loading={act.pending} onClick={() => void act.run()}>Retry</Button>
      {act.error && <span className="ml-2 text-xs text-red-600">{act.error}</span>}
    </>
  );
}
