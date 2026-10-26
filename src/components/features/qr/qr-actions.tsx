"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Copy, Download, RefreshCw } from "lucide-react";
import { Alert, Button, ButtonLink, ConfirmDialog, Dialog, Textarea, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import type { Portal, QrType } from "./qr-format";

export function CopyUrlButton({ url }: { url: string }) {
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy. Select the link and copy it manually.");
    }
  }
  return <Button variant="outline" size="sm" onClick={copy}><Copy className="size-4" aria-hidden />Copy link</Button>;
}

export function QrDownloadButtons({ portal, id, disabled }: { portal: Portal; id: string; disabled?: boolean }) {
  if (disabled) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <ButtonLink variant="outline" size="sm" href={`/api/${portal}/qr/${id}/png`} download prefetch={false}><Download className="size-4" aria-hidden />PNG</ButtonLink>
      <ButtonLink variant="outline" size="sm" href={`/api/${portal}/qr/${id}/pdf`} download prefetch={false}><Download className="size-4" aria-hidden />PDF</ButtonLink>
    </div>
  );
}

export function QrManageActions({ portal, id, type, revoked, replaced }: { portal: Portal; id: string; type: QrType; revoked: boolean; replaced: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const revoke = useAction(async (r: string) => {
    await api(`/api/${portal}/qr/${id}/revoke`, { method: "POST", body: { reason: r } });
    toast.success("QR code revoked");
    setRevokeOpen(false);
    setReason("");
    router.refresh();
  });

  function submitRevoke(e: React.FormEvent) {
    e.preventDefault();
    const r = reason.trim();
    if (r.length < 3) return setReasonError("Give a short reason (at least 3 characters)");
    if (r.length > 200) return setReasonError("Keep it under 200 characters");
    setReasonError(null);
    void revoke.run(r);
  }

  async function regenerate() {
    try {
      const fresh = await api<{ id: string }>(`/api/${portal}/qr/${id}/regenerate`, { method: "POST", body: {} });
      toast.success("New QR code issued. The old one no longer works.");
      router.push(`/${portal}/qr/${fresh.id}`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not issue a new QR code");
      throw e;
    }
  }

  const canRegenerate = type !== "ORDER" && !replaced;
  if (revoked && !canRegenerate) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {canRegenerate && <Button variant="outline" size="sm" onClick={() => setRegenOpen(true)}><RefreshCw className="size-4" aria-hidden />Regenerate</Button>}
      {!revoked && <Button variant="danger" size="sm" onClick={() => setRevokeOpen(true)}><Ban className="size-4" aria-hidden />Revoke</Button>}

      <ConfirmDialog
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        title="Regenerate this QR code?"
        description="A new code with a new link is issued and this one stops working straight away. Printed copies of the old code will need replacing."
        confirmLabel="Regenerate"
        onConfirm={regenerate}
      />

      <Dialog open={revokeOpen} onClose={() => setRevokeOpen(false)} title="Revoke this QR code?" description="Customers who scan it will see that it is no longer valid. This cannot be undone, but you can issue a new code.">
        <form onSubmit={submitRevoke} className="space-y-4" noValidate>
          {revoke.error && <Alert tone="error">{revoke.error}</Alert>}
          <Textarea label="Reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} error={reasonError ?? revoke.fieldErrors.reason} hint="Kept in the audit log" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRevokeOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={revoke.pending}>Revoke QR code</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
