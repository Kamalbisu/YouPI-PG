"use client";
import { useState } from "react";
import { CreditCard } from "lucide-react";
import { Alert, Button, Card, CardBody, CardHeader, Input } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

/** Starts an online payment and sends the browser to the hosted checkout page. */
export function PayOnlineCard({ available }: { available: boolean }) {
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const pay = useAction(async () => {
    const r = await api<{ checkoutUrl: string }>("/api/user/payments", { method: "POST", body: { amount, purpose } });
    window.location.assign(r.checkoutUrl);
  });
  return (
    <Card>
      <CardHeader title="Pay online" description="Card, UPI or net banking on a secure payment page." />
      <CardBody>
        {!available ? (
          <Alert tone="warn">Online payment is not switched on yet. You can still pay with a QR code below.</Alert>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void pay.run(); }} className="grid gap-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
            {pay.error && <div className="sm:col-span-3"><Alert tone="error">{pay.error}</Alert></div>}
            <Input label="Amount (₹)" inputMode="decimal" placeholder="250" value={amount} onChange={(e) => setAmount(e.target.value)} error={pay.fieldErrors.amount} required />
            <Input label="What is it for?" placeholder="Fee, invoice number, order..." value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={100} error={pay.fieldErrors.purpose} required />
            <Button type="submit" loading={pay.pending}><CreditCard className="size-4" />Pay now</Button>
            {pay.fieldErrors.mobile && <div className="sm:col-span-3"><Alert tone="error">{pay.fieldErrors.mobile}</Alert></div>}
          </form>
        )}
      </CardBody>
    </Card>
  );
}
