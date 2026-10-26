"use client";
import { useState } from "react";

/** Compact, expandable view of an audit entry's metadata (already redacted server-side). */
export function MetadataCell({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value === null || value === undefined || (typeof value === "object" && Object.keys(value as object).length === 0)) return <span className="text-ink-muted">-</span>;
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="max-w-xs">
      <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide" : "Show"}
      </button>
      {open && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-muted p-2 text-xs">{text}</pre>}
    </div>
  );
}
