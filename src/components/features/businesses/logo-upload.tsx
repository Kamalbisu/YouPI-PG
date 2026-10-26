"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Upload, Trash2 } from "lucide-react";
import { Alert, Button, useToast } from "@/components/ui";
import { api } from "@/components/shared/use-api";

const MAX = 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Logo picker. The server verifies the real file type from its bytes; the checks here are only a convenience. */
export function LogoUpload({ businessId, logoFileId, businessName }: { businessId: string; logoFileId: string | null; businessName: string }) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    if (!TYPES.includes(file.type)) { setError("Choose a PNG, JPEG or WebP image."); return; }
    if (file.size > MAX) { setError("The image must be 1 MB or smaller."); return; }
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/client/businesses/${businessId}/logo`, { method: "POST", body, credentials: "same-origin" });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message ?? "Upload failed. Please try again.");
      }
      toast.success("Logo updated");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true); setError(null);
    try {
      await api(`/api/client/businesses/${businessId}/logo`, { method: "DELETE" });
      toast.success("Logo removed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the logo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <div className="flex size-20 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-muted text-xl font-semibold text-ink-muted">
          {logoFileId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/files/${logoFileId}`} alt={`${businessName} logo`} className="size-full object-cover" />
          ) : (
            businessName.slice(0, 1).toUpperCase()
          )}
        </div>
        <div className="space-y-2">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" loading={busy} onClick={() => input.current?.click()}><Upload className="size-4" />{logoFileId ? "Replace logo" : "Upload logo"}</Button>
            {logoFileId && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}><Trash2 className="size-4" />Remove</Button>}
          </div>
          <p className="text-xs text-ink-muted">PNG, JPEG or WebP, up to 1 MB.</p>
        </div>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
