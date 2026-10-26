"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, DataTable, Dialog, Input, Select, Textarea, useToast } from "@/components/ui";
import { api, ApiError, useAction } from "@/components/shared/use-api";
import { formatMinor, minorToMajorString, parseMajorToMinor } from "@/lib/money";
import { formatDate } from "@/lib/utils";
import { bpsToPercentString, describeOfferValue, parsePercentToBps, type BusinessOption, type Portal } from "./catalog-format";

export interface OfferRow {
  id: string;
  businessId: string;
  business: { id: string; name: string };
  title: string;
  description: string | null;
  code: string;
  type: "PERCENT" | "FIXED";
  value: number;
  minOrderMinor: number;
  maxDiscountMinor: number | null;
  validFrom: Date | string | null;
  validTo: Date | string | null;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
function toDateInput(v: Date | string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const validDateInput = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime());

function OfferDialog({ portal, onClose, businesses, offer }: { portal: Portal; onClose: () => void; businesses: BusinessOption[]; offer: OfferRow | null }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState(() => ({
    businessId: offer?.businessId ?? businesses[0]?.id ?? "",
    title: offer?.title ?? "",
    description: offer?.description ?? "",
    code: offer?.code ?? "",
    type: (offer?.type ?? "PERCENT") as "PERCENT" | "FIXED",
    value: offer ? (offer.type === "PERCENT" ? bpsToPercentString(offer.value) : minorToMajorString(offer.value)) : "",
    minOrder: offer && offer.minOrderMinor > 0 ? minorToMajorString(offer.minOrderMinor) : "",
    maxDiscount: offer?.maxDiscountMinor ? minorToMajorString(offer.maxDiscountMinor) : "",
    validFrom: toDateInput(offer?.validFrom ?? null),
    validTo: toDateInput(offer?.validTo ?? null),
    usageLimit: offer?.usageLimit ? String(offer.usageLimit) : "",
    isActive: offer?.isActive ?? true,
  }));
  const [local, setLocal] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  const save = useAction(async (body: Record<string, unknown>) => {
    if (offer) await api(`/api/${portal}/offers/${offer.id}`, { method: "PATCH", body });
    else await api(`/api/${portal}/offers`, { method: "POST", body: { ...body, businessId: f.businessId } });
    toast.success(offer ? "Offer updated" : "Offer created");
    router.refresh();
    onClose();
  });

  function submit() {
    const errs: Record<string, string> = {};
    if (!f.businessId) errs.businessId = "Choose a business";
    if (f.title.trim().length < 2) errs.title = "Enter a title";
    const code = f.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) errs.code = "Use 3 to 24 letters, numbers, dashes or underscores";
    let value = 0;
    if (f.type === "PERCENT") {
      const v = parsePercentToBps(f.value);
      if (v === null || v < 1 || v > 10000) errs.value = "Enter a percentage between 0 and 100";
      else value = v;
    } else {
      const v = parseMajorToMinor(f.value);
      if (v === null || v < 1) errs.value = "Enter an amount such as 50 or 50.50";
      else value = v;
    }
    let minOrderMinor = 0;
    if (f.minOrder.trim()) {
      const v = parseMajorToMinor(f.minOrder);
      if (v === null) errs.minOrder = "Enter an amount such as 500";
      else minOrderMinor = v;
    }
    let maxDiscountMinor: number | null = null;
    if (f.maxDiscount.trim()) {
      const v = parseMajorToMinor(f.maxDiscount);
      if (v === null || v < 1) errs.maxDiscount = "Enter an amount such as 100";
      else maxDiscountMinor = v;
    }
    let usageLimit: number | null = null;
    if (f.usageLimit.trim()) {
      if (!/^\d{1,8}$/.test(f.usageLimit.trim()) || parseInt(f.usageLimit, 10) < 1) errs.usageLimit = "Enter a whole number above zero";
      else usageLimit = parseInt(f.usageLimit, 10);
    }
    if (f.validFrom && !validDateInput(f.validFrom)) errs.validFrom = "Enter a valid date";
    if (f.validTo && !validDateInput(f.validTo)) errs.validTo = "Enter a valid date";
    if (!errs.validFrom && !errs.validTo && f.validFrom && f.validTo && f.validTo < f.validFrom) errs.validTo = "End date must be after the start date";
    setLocal(errs);
    if (Object.keys(errs).length) return;
    void save.run({
      title: f.title.trim(),
      description: f.description.trim() || (offer ? null : undefined),
      code,
      type: f.type,
      value,
      minOrderMinor,
      maxDiscountMinor: f.type === "PERCENT" ? maxDiscountMinor : null,
      validFrom: f.validFrom ? new Date(`${f.validFrom}T00:00:00`).toISOString() : null,
      validTo: f.validTo ? new Date(`${f.validTo}T23:59:59`).toISOString() : null,
      usageLimit,
      isActive: f.isActive,
    });
  }
  const err = (k: string) => local[k] ?? save.fieldErrors[k];

  return (
    <Dialog open onClose={onClose} title={offer ? "Edit offer" : "New offer"} description="Customers enter the coupon code at checkout." size="lg">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {save.error && <Alert tone="error">{save.error}</Alert>}
        {!offer && businesses.length > 1 && (
          <Select label="Business" value={f.businessId} onChange={(e) => set("businessId", e.target.value)} error={err("businessId")}>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Title" value={f.title} maxLength={80} onChange={(e) => set("title", e.target.value)} error={err("title")} />
          <Input label="Coupon code" value={f.code} maxLength={24} onChange={(e) => set("code", e.target.value.toUpperCase())} error={err("code")} placeholder="WELCOME10" />
        </div>
        <Textarea label="Description" value={f.description} maxLength={300} onChange={(e) => set("description", e.target.value)} error={err("description")} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Discount type" value={f.type} onChange={(e) => setF((s) => ({ ...s, type: e.target.value as "PERCENT" | "FIXED", value: "", maxDiscount: "" }))}>
            <option value="PERCENT">Percent off</option>
            <option value="FIXED">Amount off</option>
          </Select>
          <Input label={f.type === "PERCENT" ? "Percent off (%)" : "Amount off (INR)"} inputMode="decimal" value={f.value} onChange={(e) => set("value", e.target.value)} error={err("value")} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Minimum order (INR)" inputMode="decimal" value={f.minOrder} onChange={(e) => set("minOrder", e.target.value)} error={err("minOrder") ?? err("minOrderMinor")} hint="Leave empty for no minimum" />
          {f.type === "PERCENT" && (
            <Input label="Maximum discount (INR)" inputMode="decimal" value={f.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} error={err("maxDiscount") ?? err("maxDiscountMinor")} hint="Leave empty for no cap" />
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Starts on" type="date" value={f.validFrom} onChange={(e) => set("validFrom", e.target.value)} error={err("validFrom")} />
          <Input label="Ends on" type="date" value={f.validTo} onChange={(e) => set("validTo", e.target.value)} error={err("validTo")} />
          <Input label="Usage limit" inputMode="numeric" value={f.usageLimit} onChange={(e) => set("usageLimit", e.target.value)} error={err("usageLimit")} hint="Leave empty for unlimited" />
        </div>
        <Checkbox label="Active" hint="Inactive offers cannot be applied at checkout." checked={f.isActive} onChange={(e) => set("isActive", e.target.checked)} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={save.pending}>Cancel</Button>
          <Button type="submit" loading={save.pending}>{offer ? "Save changes" : "Create offer"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function NewOfferButton({ portal, businesses }: { portal: Portal; businesses: BusinessOption[] }) {
  const [open, setOpen] = useState(false);
  if (businesses.length === 0) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="size-4" />New offer</Button>
      {open && <OfferDialog portal={portal} onClose={() => setOpen(false)} businesses={businesses} offer={null} />}
    </>
  );
}

function offerState(o: OfferRow): { label: string; tone: "green" | "gray" | "amber" } {
  const now = Date.now();
  if (!o.isActive) return { label: "Inactive", tone: "gray" };
  if (o.validTo && new Date(o.validTo).getTime() < now) return { label: "Expired", tone: "gray" };
  if (o.validFrom && new Date(o.validFrom).getTime() > now) return { label: "Scheduled", tone: "amber" };
  if (o.usageLimit !== null && o.usedCount >= o.usageLimit) return { label: "Used up", tone: "gray" };
  return { label: "Live", tone: "green" };
}

export function OfferTable({ portal, rows, showBusiness, businesses, emptyAction, filtered }: {
  portal: Portal; rows: OfferRow[]; showBusiness: boolean; businesses: BusinessOption[]; emptyAction?: React.ReactNode; filtered: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<OfferRow | null>(null);
  const [deleting, setDeleting] = useState<OfferRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(o: OfferRow) {
    setBusyId(o.id);
    try {
      await api(`/api/${portal}/offers/${o.id}`, { method: "PATCH", body: { isActive: !o.isActive } });
      toast.success(o.isActive ? "Offer deactivated" : "Offer activated");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not update the offer");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(o: OfferRow) {
    try {
      const res = await api<{ deleted: boolean; deactivated: boolean }>(`/api/${portal}/offers/${o.id}`, { method: "DELETE" });
      toast.success(res.deactivated ? "Offer was used by orders, so it was deactivated instead of deleted" : "Offer deleted");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not delete the offer");
      throw e;
    }
  }

  return (
    <>
      <DataTable
        rows={rows}
        rowKey={(o) => o.id}
        empty={{ title: filtered ? "No offers match" : "No offers yet", description: filtered ? "Try changing or clearing the filters." : "Create a coupon code your customers can use at checkout.", action: filtered ? undefined : emptyAction }}
        columns={[
          { key: "offer", header: "Offer", cell: (o) => (<div><p className="font-medium">{o.title}</p><p className="font-mono text-xs text-ink-muted">{o.code}</p></div>) },
          ...(showBusiness ? [{ key: "biz", header: "Business", cell: (o: OfferRow) => o.business.name }] : []),
          {
            key: "value",
            header: "Discount",
            cell: (o) => (
              <div>
                <p>{describeOfferValue(o)}</p>
                <p className="text-xs text-ink-muted">
                  {o.minOrderMinor > 0 ? `Min order ${formatMinor(o.minOrderMinor)}` : "No minimum"}
                  {o.maxDiscountMinor ? `, max ${formatMinor(o.maxDiscountMinor)}` : ""}
                </p>
              </div>
            ),
          },
          { key: "valid", header: "Valid", cell: (o) => (o.validFrom || o.validTo ? `${o.validFrom ? formatDate(o.validFrom) : "Any time"} to ${o.validTo ? formatDate(o.validTo) : "no end"}` : "Always") },
          { key: "used", header: "Used", align: "right" as const, cell: (o) => (o.usageLimit ? `${o.usedCount} / ${o.usageLimit}` : o.usedCount) },
          { key: "state", header: "Status", cell: (o) => { const s = offerState(o); return <Badge tone={s.tone}>{s.label}</Badge>; } },
          {
            key: "actions",
            header: "",
            align: "right" as const,
            cell: (o) => (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="outline" loading={busyId === o.id} onClick={() => void toggle(o)}>{o.isActive ? "Deactivate" : "Activate"}</Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(o)} aria-label={`Edit ${o.title}`}><Pencil className="size-4" /><span className="hidden sm:inline">Edit</span></Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(o)} aria-label={`Delete ${o.title}`}><Trash2 className="size-4" /><span className="hidden sm:inline">Delete</span></Button>
              </div>
            ),
          },
        ]}
      />
      {editing && <OfferDialog key={editing.id} portal={portal} onClose={() => setEditing(null)} businesses={businesses} offer={editing} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        danger
        title="Delete this offer?"
        description={deleting ? `${deleting.title} (${deleting.code}) will stop working. If orders already used it, it is deactivated instead so order history stays intact.` : ""}
        confirmLabel="Delete"
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </>
  );
}
