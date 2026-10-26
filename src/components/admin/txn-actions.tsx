"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Alert, Button, Dialog, Input, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

/** Confirm / Reject buttons for one pending transaction. */
export function TxnActions({ id, txnId }: { id: string; txnId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  async function confirm() {
    setConfirming(true);
    try {
      await api(`/api/admin/transactions/${id}/confirm`, { method: "POST" });
      toast.success("Transaction confirmed");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not confirm");
    } finally {
      setConfirming(false);
    }
  }
  const reject = useAction(async () => {
    await api(`/api/admin/transactions/${id}/reject`, { method: "POST", body: { reason } });
    toast.success("Transaction rejected");
    setOpen(false);
    setReason("");
    router.refresh();
  });
  return (
    <div className="flex items-center justify-end gap-2">
      <Button size="sm" loading={confirming} onClick={confirm}><Check className="size-4" />Confirm</Button>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}><X className="size-4" />Reject</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Reject transaction" description={`Tell the user why ${txnId} was rejected. They will see this reason.`}>
        <form onSubmit={(e) => { e.preventDefault(); void reject.run(); }} className="space-y-4">
          {reject.error && <Alert tone="error">{reject.error}</Alert>}
          <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} error={reject.fieldErrors.reason} autoFocus required />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={reject.pending}>Reject</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
