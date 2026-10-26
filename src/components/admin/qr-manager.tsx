"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, Input, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export interface QrRow {
  id: string;
  label: string;
  amountPaise: number | null;
  active: boolean;
  forAll: boolean;
  transactions: number;
  assignments: { id: string; name: string; username: string }[];
}

const rupees = (p: number | null) => (p == null ? "" : String(p / 100));
const money = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The multipart upload bypasses the JSON helper but returns the same {data}/{error} shape. */
async function submitQr(url: string, method: "POST" | "PATCH", fd: FormData) {
  const res = await fetch(url, { method, body: fd, credentials: "same-origin" });
  const json = (await res.json().catch(() => null)) as { error?: { message: string; details?: { fields?: Record<string, string> } } } | null;
  if (!res.ok || json?.error) {
    const err = new Error(json?.error?.message ?? "Upload failed. Please try again.") as Error & { fields?: Record<string, string> };
    err.fields = json?.error?.details?.fields;
    throw err;
  }
}

function QrFormDialog({ qr, open, onClose }: { qr?: QrRow; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [fields, setFields] = useState<Record<string, string>>({});
  const save = useAction(async (form: HTMLFormElement) => {
    const fd = new FormData(form);
    // Unchecked boxes are absent from FormData; send explicit values.
    fd.set("active", fd.get("active") ? "true" : "false");
    fd.set("forAll", fd.get("forAll") ? "true" : "false");
    const file = fd.get("file");
    if (file instanceof File && file.size === 0) fd.delete("file");
    try {
      await submitQr(qr ? `/api/admin/qrs/${qr.id}` : "/api/admin/qrs", qr ? "PATCH" : "POST", fd);
    } catch (e) {
      setFields((e as { fields?: Record<string, string> }).fields ?? {});
      throw e;
    }
    toast.success(qr ? "QR updated" : "QR added");
    onClose();
    router.refresh();
  });
  // Show upload errors from the helper (plain Error) as a message.
  return (
    <Dialog open={open} onClose={onClose} title={qr ? "Edit QR code" : "Add QR code"} description="PNG, JPG or WebP, up to 2 MB.">
      <form
        key={qr?.id ?? "new"}
        onSubmit={(e) => { e.preventDefault(); setFields({}); void save.run(e.currentTarget); }}
        className="space-y-4"
      >
        {save.error && <Alert tone="error">{save.error}</Alert>}
        <Input name="label" label="Label" defaultValue={qr?.label} maxLength={80} required />
        <Input name="amount" label="Amount in rupees (optional)" inputMode="decimal" defaultValue={rupees(qr?.amountPaise ?? null)} placeholder="e.g. 500" error={fields.amount} />
        <Input name="file" type="file" label={qr ? "Replace image (optional)" : "QR image"} accept="image/png,image/jpeg,image/webp" required={!qr} error={fields.file} />
        <Checkbox name="active" label="Active" hint="Inactive QR codes are hidden from users." defaultChecked={qr?.active ?? true} />
        <Checkbox name="forAll" label="Show to all users" hint="Otherwise only users you assign it to can see it." defaultChecked={qr?.forAll ?? false} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.pending}>{qr ? "Save" : "Add QR"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function QrCard({ qr }: { qr: QrRow }) {
  const router = useRouter();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [username, setUsername] = useState("");
  const assign = useAction(async () => {
    await api(`/api/admin/qrs/${qr.id}/assignments`, { method: "POST", body: { username: username.trim().toLowerCase() } });
    setUsername("");
    toast.success("QR assigned");
    router.refresh();
  });
  async function unassign(userId: string) {
    try {
      await api(`/api/admin/qrs/${qr.id}/assignments`, { method: "DELETE", body: { userId } });
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove");
    }
  }
  return (
    <Card className="flex flex-col gap-4 p-4 sm:flex-row">
      <div className="mx-auto size-40 shrink-0 overflow-hidden rounded-lg border border-line bg-white sm:mx-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/qr/${qr.id}/image`} alt={`QR code: ${qr.label}`} className="size-full object-contain" loading="lazy" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold">{qr.label}</h3>
            <p className="text-sm text-ink-muted">{qr.amountPaise != null ? money(qr.amountPaise) : "Any amount"} · {qr.transactions} submission{qr.transactions === 1 ? "" : "s"}</p>
          </div>
          <div className="flex gap-1.5">
            <Badge tone={qr.active ? "green" : "gray"}>{qr.active ? "Active" : "Inactive"}</Badge>
            {qr.forAll && <Badge tone="blue">All users</Badge>}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-muted">Assigned to</p>
          {qr.assignments.length === 0 ? (
            <p className="text-sm text-ink-muted">{qr.forAll ? "Everyone can see this QR." : "Nobody yet."}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {qr.assignments.map((u) => (
                <li key={u.id} className="inline-flex items-center gap-1 rounded-full bg-surface-muted py-0.5 pr-1 pl-2.5 text-xs">
                  {u.name} (@{u.username})
                  <button type="button" aria-label={`Remove ${u.username}`} onClick={() => unassign(u.id)} className="rounded-full p-0.5 hover:bg-line"><X className="size-3" /></button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={(e) => { e.preventDefault(); if (username.trim()) void assign.run(); }} className="mt-2 flex items-end gap-2">
            <div className="flex-1"><Input label="Assign to username" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} error={assign.error ?? undefined} /></div>
            <Button type="submit" variant="outline" loading={assign.pending} className="mb-px">Assign</Button>
          </form>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEdit(true)}><Pencil className="size-4" />Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => setDel(true)}><Trash2 className="size-4" />Delete</Button>
        </div>
      </div>
      {edit && <QrFormDialog qr={qr} open onClose={() => setEdit(false)} />}
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        danger
        title="Delete this QR code?"
        description={qr.transactions > 0 ? "It has transaction history, so it will be switched off instead of deleted." : "This cannot be undone."}
        confirmLabel={qr.transactions > 0 ? "Deactivate" : "Delete"}
        onConfirm={async () => {
          try {
            const r = await api<{ deleted: boolean }>(`/api/admin/qrs/${qr.id}`, { method: "DELETE" });
            toast.success(r.deleted ? "QR deleted" : "QR deactivated");
            router.refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not delete");
            throw e;
          }
        }}
      />
    </Card>
  );
}

export function QrManager({ qrs }: { qrs: QrRow[] }) {
  const [add, setAdd] = useState(false);
  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setAdd(true)}><Plus className="size-4" />Add QR code</Button>
      </div>
      {qrs.length === 0 ? (
        <Card><EmptyState title="No QR codes yet" description="Upload a QR image and assign it to users." action={<Button onClick={() => setAdd(true)}>Add QR code</Button>} /></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">{qrs.map((q) => <QrCard key={q.id} qr={q} />)}</div>
      )}
      {add && <QrFormDialog open onClose={() => setAdd(false)} />}
    </>
  );
}
