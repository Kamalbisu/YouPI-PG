"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

export function Dialog({ open, onClose, title, description, children, size = "md" }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; size?: "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cn("m-auto w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50", size === "lg" ? "max-w-2xl" : "max-w-md")}
    >
      {open && (
        <div className="p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
            </div>
            <button aria-label="Close" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-muted"><X className="size-5" /></button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Confirmation for destructive / sensitive actions. onConfirm may be async; errors keep the dialog open. */
export function ConfirmDialog({ open, onClose, title, description, confirmLabel = "Confirm", danger, onConfirm }: {
  open: boolean; onClose: () => void; title: string; description: string; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try { await onConfirm(); onClose(); } catch { /* caller shows the error */ } finally { setBusy(false); }
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
