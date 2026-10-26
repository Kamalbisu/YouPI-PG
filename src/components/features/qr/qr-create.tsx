"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Alert, Button, Dialog, Input, Select, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import { parseMajorToMinor } from "@/lib/money";
import type { BusinessOption, Portal } from "./qr-format";

type Kind = "BUSINESS" | "PRODUCT" | "DYNAMIC_PAYMENT";
type AmountMode = "fixed" | "custom";
interface ProductOption { id: string; name: string }

export function NewQrButton({ portal, businesses }: { portal: Portal; businesses: BusinessOption[] }) {
  const [open, setOpen] = useState(false);
  if (businesses.length === 0) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="size-4" aria-hidden />New QR code</Button>
      {open && <QrCreateDialog portal={portal} businesses={businesses} onClose={() => setOpen(false)} />}
    </>
  );
}

function QrCreateDialog({ portal, businesses, onClose }: { portal: Portal; businesses: BusinessOption[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [businessId, setBusinessId] = useState(businesses[0]?.id ?? "");
  const [type, setType] = useState<Kind>("BUSINESS");
  const [label, setLabel] = useState("");
  const [productId, setProductId] = useState("");
  const [amountMode, setAmountMode] = useState<AmountMode>("custom");
  const [fixed, setFixed] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [expires, setExpires] = useState("");
  const [products, setProducts] = useState<ProductOption[] | null>(null);
  const [productsError, setProductsError] = useState(false);
  const [local, setLocal] = useState<Record<string, string>>({});

  useEffect(() => {
    if (type !== "PRODUCT" || !businessId) return;
    let cancelled = false;
    setProducts(null);
    setProductsError(false);
    setProductId("");
    api<{ items: ProductOption[] }>(`/api/${portal}/products?businessId=${encodeURIComponent(businessId)}&status=available&pageSize=100`)
      .then((r) => { if (!cancelled) setProducts(r.items); })
      .catch(() => { if (!cancelled) { setProducts([]); setProductsError(true); } });
    return () => { cancelled = true; };
  }, [type, businessId, portal]);

  const save = useAction(async (body: Record<string, unknown>) => {
    const created = await api<{ id: string }>(`/api/${portal}/qr`, { method: "POST", body });
    toast.success("QR code created");
    onClose();
    router.push(`/${portal}/qr/${created.id}`);
    router.refresh();
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const body: Record<string, unknown> = { businessId, type, label: label.trim() };
    if (label.trim().length < 2) errs.label = "Enter a label of at least 2 characters";
    if (type === "PRODUCT") {
      if (!productId) errs.productId = "Choose a product";
      else body.productId = productId;
    }
    if (type === "DYNAMIC_PAYMENT") {
      if (amountMode === "fixed") {
        const v = parseMajorToMinor(fixed);
        if (v === null || v <= 0) errs.fixed = "Enter an amount greater than zero";
        else body.fixedAmountMinor = v;
      } else {
        body.allowCustomAmount = true;
        if (min.trim()) {
          const v = parseMajorToMinor(min);
          if (v === null || v <= 0) errs.min = "Enter a valid minimum";
          else body.minAmountMinor = v;
        }
        if (max.trim()) {
          const v = parseMajorToMinor(max);
          if (v === null || v <= 0) errs.max = "Enter a valid maximum";
          else body.maxAmountMinor = v;
        }
        if (typeof body.minAmountMinor === "number" && typeof body.maxAmountMinor === "number" && body.minAmountMinor > body.maxAmountMinor) errs.max = "Maximum must be at least the minimum";
      }
    }
    if (expires) {
      const d = new Date(`${expires}T23:59:59`);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) errs.expires = "Pick a date in the future";
      else body.expiresAt = d.toISOString();
    }
    setLocal(errs);
    if (Object.keys(errs).length) return;
    void save.run(body);
  }

  const err = (k: string, serverKey = k) => local[k] ?? save.fieldErrors[serverKey];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Dialog open onClose={onClose} title="New QR code" description="Customers scan the code to open your payment page." size="lg">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {save.error && Object.keys(save.fieldErrors).length === 0 && <Alert tone="error">{save.error}</Alert>}
        {businesses.length > 1 && (
          <Select label="Business" value={businessId} onChange={(e) => setBusinessId(e.target.value)} error={err("businessId")}>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Type" value={type} onChange={(e) => setType(e.target.value as Kind)}>
            <option value="BUSINESS">Business - general payments page</option>
            <option value="PRODUCT">Product - a single item</option>
            <option value="DYNAMIC_PAYMENT">Payment - fixed or custom amount</option>
          </Select>
          <Input label="Label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} error={err("label")} placeholder="Front counter" hint="Only you see this" />
        </div>
        {type === "PRODUCT" && (
          <Select label="Product" value={productId} onChange={(e) => setProductId(e.target.value)} error={err("productId")} disabled={products === null} hint={products === null ? "Loading products" : products.length === 0 ? "This business has no available products" : undefined}>
            <option value="">Choose a product</option>
            {(products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        {productsError && <Alert tone="warn">Could not load products. Close this dialog and try again.</Alert>}
        {type === "DYNAMIC_PAYMENT" && (
          <div className="space-y-4 rounded-lg border border-line p-4">
            <Select label="Amount" value={amountMode} onChange={(e) => setAmountMode(e.target.value as AmountMode)}>
              <option value="custom">Customer enters the amount</option>
              <option value="fixed">Fixed amount</option>
            </Select>
            {amountMode === "fixed" ? (
              <Input label="Amount (INR)" inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} error={err("fixed", "fixedAmountMinor")} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Minimum (INR)" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} error={err("min", "minAmountMinor")} hint="Optional" />
                <Input label="Maximum (INR)" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} error={err("max", "maxAmountMinor")} hint="Optional" />
              </div>
            )}
          </div>
        )}
        <Input label="Expires on" type="date" min={today} value={expires} onChange={(e) => setExpires(e.target.value)} error={err("expires", "expiresAt")} hint="Optional. Leave empty for no expiry" />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.pending}>Create QR code</Button>
        </div>
      </form>
    </Dialog>
  );
}
