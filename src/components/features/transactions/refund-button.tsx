"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { Alert, Button, Dialog, Input, Textarea, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import { formatMinor, minorToMajorString, parseMajorToMinor } from "@/lib/money";
import type { Portal } from "./txn-format";

/** Refund dialog. Idempotency key is generated per dialog opening so a double click or retry never refunds twice. */
export function RefundButton({ portal, transactionId, refundableMinor, currency }: { portal: Portal; transactionId: string; refundableMinor: number; currency: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});

  const submit = useAction(async (amountMinor: number, why: string) => {
    await api(`/api/${portal}/refunds`, { method: "POST", body: { transactionId, amountMinor, reason: why, idempotencyKey: key } });
    toast.success("Refund requested");
    setOpen(false);
    router.refresh();
  });

  function openDialog() {
    setKey(`rf-${crypto.randomUUID()}`);
    setAmount(minorToMajorString(refundableMinor));
    setReason("");
    setErrors({});
    setOpen(true);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const minor = parseMajorToMinor(amount);
    const next: { amount?: string; reason?: string } = {};
    if (minor === null || minor <= 0) next.amount = "Enter an amount such as 250 or 250.50";
    else if (minor > refundableMinor) next.amount = `At most ${formatMinor(refundableMinor, currency)} can be refunded`;
    if (reason.trim().length < 3) next.reason = "Give a short reason (at least 3 characters)";
    setErrors(next);
    if (next.amount || next.reason || minor === null) return;
    void submit.run(minor, reason.trim());
  }

  if (refundableMinor <= 0) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog}><Undo2 className="size-4" aria-hidden />Refund</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Refund this payment" description={`Up to ${formatMinor(refundableMinor, currency)} can still be refunded. The money goes back to the customer through the original payment method.`}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {submit.error && <Alert tone="error">{submit.error}</Alert>}
          <Input label="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={errors.amount ?? submit.fieldErrors.amountMinor} hint={`In ${currency}`} />
          <Textarea label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} error={errors.reason ?? submit.fieldErrors.reason} hint="Kept in the audit log" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={submit.pending}>Cancel</Button>
            <Button type="submit" variant="danger" loading={submit.pending}>Refund</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
