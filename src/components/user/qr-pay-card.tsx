"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody, Alert, Button, Input, StatusBadge } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import { formatRupees } from "@/lib/money";

export interface QrView {
  id: string;
  label: string;
  amountPaise: number | null;
  transactions: { id: string; txnId: string; status: string; rejectReason: string | null; createdAt: string }[];
}

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export function QrPayCard({ qr }: { qr: QrView }) {
  const router = useRouter();
  const [txnId, setTxnId] = useState("");
  const [sent, setSent] = useState(false);
  const submit = useAction(async () => {
    await api("/api/user/transactions", { method: "POST", body: { qrId: qr.id, txnId } });
    setTxnId("");
    setSent(true);
    router.refresh();
  });
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">{qr.label}</h3>
            {qr.amountPaise != null && <p className="text-sm text-ink-muted">Amount to pay: <span className="font-medium text-ink">{formatRupees(qr.amountPaise)}</span></p>}
          </div>
        </div>
        <div className="mx-auto w-full max-w-[16rem] rounded-xl border border-line bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/qr/${qr.id}/image`} alt={`QR code: ${qr.label}`} className="aspect-square w-full object-contain" loading="lazy" decoding="async" />
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setSent(false); void submit.run(); }} className="space-y-3">
          {submit.error && <Alert tone="error">{submit.error}</Alert>}
          {sent && !submit.error && <Alert tone="success">Submitted. The admin will confirm it soon.</Alert>}
          <Input
            label="Transaction ID (UTR / reference)"
            placeholder="e.g. 412345678901"
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={40}
            value={txnId}
            onChange={(e) => setTxnId(e.target.value.replace(/\s/g, ""))}
            error={submit.fieldErrors.txnId}
            required
          />
          <Button type="submit" className="w-full" loading={submit.pending} disabled={txnId.length < 8}>Submit for confirmation</Button>
        </form>
        {qr.transactions.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">Your submissions</h4>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {qr.transactions.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-mono">{t.txnId}</p>
                    <p className="text-xs text-ink-muted">{when(t.createdAt)}</p>
                    {t.status === "REJECTED" && t.rejectReason && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">Reason: {t.rejectReason}</p>}
                  </div>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
