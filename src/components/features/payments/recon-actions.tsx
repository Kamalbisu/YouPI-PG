"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Textarea, Alert, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

/** Per-row actions on the reconciliation page. Every one is admin-only and audited on the server. */
export function ReconActions({ kind, id, orderId, canRefetch }: { kind: string; id: string; orderId: string | null; canRefetch: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>();

  const refetch = useAction(async () => {
    const r = await api<{ orderCode: string; orderStatus: string }>("/api/admin/reconciliation/refetch", { method: "POST", body: { orderId } });
    toast.success(`${r.orderCode}: ${r.orderStatus.toLowerCase().replace(/_/g, " ")}`);
    router.refresh();
  });
  const reprocess = useAction(async () => {
    await api(`/api/admin/reconciliation/webhooks/${id}/reprocess`, { method: "POST" });
    toast.success("Webhook reprocessed");
    router.refresh();
  });
  const review = useAction(async () => {
    await api("/api/admin/reconciliation/review", { method: "POST", body: { kind, id, note: note.trim() } });
    toast.success("Marked as reviewed");
    setOpen(false);
    router.refresh();
  });

  const err = refetch.error ?? reprocess.error;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap gap-2">
        {canRefetch && orderId && <Button variant="outline" size="sm" loading={refetch.pending} onClick={() => void refetch.run()}>Check with provider</Button>}
        {kind === "FAILED_WEBHOOK" && <Button variant="outline" size="sm" loading={reprocess.pending} onClick={() => void reprocess.run()}>Reprocess</Button>}
        <Button variant="ghost" size="sm" onClick={() => { setNote(""); setNoteError(undefined); review.setError(null); setOpen(true); }}>Mark reviewed</Button>
      </div>
      {err && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      <Dialog open={open} onClose={() => setOpen(false)} title="Mark as reviewed" description="Reviewed items leave the open list. Your note is kept in the audit log.">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length < 3) { setNoteError("Add a short note (at least 3 characters)"); return; }
            setNoteError(undefined);
            void review.run();
          }}
        >
          {review.error && <Alert tone="error">{review.error}</Alert>}
          <Textarea label="Note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} error={noteError ?? review.fieldErrors.note} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={review.pending}>Cancel</Button>
            <Button type="submit" loading={review.pending}>Mark reviewed</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
