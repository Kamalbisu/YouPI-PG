"use client";
import { useState } from "react";
import { Alert, Button, Dialog, Textarea } from "@/components/ui";

/** Dialog that collects a short reason before a sensitive action (suspend, reject, ...). */
export function ReasonDialog({
  open, onClose, title, description, confirmLabel, danger, required = true, onSubmit,
}: {
  open: boolean; onClose: () => void; title: string; description: string; confirmLabel: string; danger?: boolean; required?: boolean;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setReason(""); setError(null); onClose(); };
  return (
    <Dialog open={open} onClose={close} title={title} description={description}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (required && reason.trim().length < 3) { setError("Give a reason (at least 3 characters)"); return; }
          setBusy(true); setError(null);
          try { await onSubmit(reason.trim()); setReason(""); onClose(); }
          catch (err) { setError(err instanceof Error ? err.message : "Something went wrong. Please try again."); }
          finally { setBusy(false); }
        }}
      >
        {error && <Alert tone="error">{error}</Alert>}
        <Textarea label={required ? "Reason" : "Reason (optional)"} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} loading={busy}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}
