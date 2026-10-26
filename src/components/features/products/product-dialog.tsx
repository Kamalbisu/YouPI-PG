"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Trash2 } from "lucide-react";
import { Alert, Button, Checkbox, Dialog, Input, Select, Textarea, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import { minorToMajorString, parseMajorToMinor } from "@/lib/money";
import { bpsToPercentString, parsePercentToBps, type BusinessOption, type Portal } from "./catalog-format";

export interface ProductFormValue {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  kind: "PRODUCT" | "SERVICE";
  sku: string | null;
  priceMinor: number;
  taxBps: number | null;
  discountType: "NONE" | "PERCENT" | "FIXED";
  discountValue: number;
  imageFileId: string | null;
  imageUrl: string | null;
  isAvailable: boolean;
  trackInventory: boolean;
  stockQty: number;
  categoryId: string | null;
}

interface CategoryOption {
  id: string;
  name: string;
}

const MAX_IMAGE_BYTES = 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

interface FormState {
  businessId: string;
  name: string;
  description: string;
  kind: "PRODUCT" | "SERVICE";
  sku: string;
  price: string;
  tax: string;
  discountType: "NONE" | "PERCENT" | "FIXED";
  discountValue: string;
  categoryId: string;
  isAvailable: boolean;
  trackInventory: boolean;
  stockQty: string;
  imageFileId: string | null;
  imageUrl: string | null;
}

function initial(product: ProductFormValue | null, businesses: BusinessOption[]): FormState {
  if (!product) {
    return {
      businessId: businesses[0]?.id ?? "", name: "", description: "", kind: "PRODUCT", sku: "", price: "", tax: "",
      discountType: "NONE", discountValue: "", categoryId: "", isAvailable: true, trackInventory: false, stockQty: "0",
      imageFileId: null, imageUrl: null,
    };
  }
  return {
    businessId: product.businessId,
    name: product.name,
    description: product.description ?? "",
    kind: product.kind,
    sku: product.sku ?? "",
    price: minorToMajorString(product.priceMinor),
    tax: product.taxBps === null ? "" : bpsToPercentString(product.taxBps),
    discountType: product.discountType,
    discountValue:
      product.discountType === "PERCENT" ? bpsToPercentString(product.discountValue)
      : product.discountType === "FIXED" ? minorToMajorString(product.discountValue)
      : "",
    categoryId: product.categoryId ?? "",
    isAvailable: product.isAvailable,
    trackInventory: product.trackInventory,
    stockQty: String(product.stockQty),
    imageFileId: product.imageFileId,
    imageUrl: product.imageUrl,
  };
}

export function ProductDialog({ portal, open, onClose, businesses, product }: {
  portal: Portal;
  open: boolean;
  onClose: () => void;
  businesses: BusinessOption[];
  product: ProductFormValue | null;
}) {
  const [form, setForm] = useState<FormState>(() => initial(product, businesses));
  // Reset whenever the dialog is opened for a (different) product.
  useEffect(() => {
    if (open) setForm(initial(product, businesses));
  }, [open, product, businesses]);
  if (!open) return <Dialog open={false} onClose={onClose} title="Product">{null}</Dialog>;
  return (
    <ProductDialogBody
      key={product?.id ?? "new"}
      portal={portal}
      onClose={onClose}
      businesses={businesses}
      product={product}
      form={form}
      setForm={setForm}
    />
  );
}

function ProductDialogBody({ portal, onClose, businesses, product, form, setForm }: {
  portal: Portal;
  onClose: () => void;
  businesses: BusinessOption[];
  product: ProductFormValue | null;
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [catError, setCatError] = useState<string | null>(null);
  const editing = Boolean(product);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });

  useEffect(() => {
    if (!form.businessId) return;
    let live = true;
    api<CategoryOption[]>(`/api/${portal}/categories?businessId=${encodeURIComponent(form.businessId)}`)
      .then((c) => { if (live) { setCategories(c); setCatError(null); } })
      .catch(() => { if (live) setCatError("Categories could not be loaded."); });
    return () => { live = false; };
  }, [portal, form.businessId]);

  function validate(): Record<string, unknown> | null {
    const errs: Record<string, string> = {};
    if (!form.businessId) errs.businessId = "Choose a business";
    if (!form.name.trim()) errs.name = "Enter a name";
    const priceMinor = parseMajorToMinor(form.price);
    if (priceMinor === null || priceMinor < 1) errs.price = "Enter a price such as 120 or 120.50";
    let taxBps: number | null = null;
    if (form.tax.trim()) {
      taxBps = parsePercentToBps(form.tax);
      if (taxBps === null || taxBps > 10000) errs.tax = "Enter a percentage between 0 and 100";
    }
    let discountValue = 0;
    if (form.discountType === "PERCENT") {
      const v = parsePercentToBps(form.discountValue);
      if (v === null || v < 1 || v > 10000) errs.discountValue = "Enter a percentage between 0 and 100";
      else discountValue = v;
    } else if (form.discountType === "FIXED") {
      const v = parseMajorToMinor(form.discountValue);
      if (v === null || v < 1) errs.discountValue = "Enter an amount such as 10 or 10.50";
      else if (priceMinor !== null && v > priceMinor) errs.discountValue = "Discount cannot be more than the price";
      else discountValue = v ?? 0;
    }
    let stockQty = 0;
    if (form.trackInventory) {
      if (!/^\d{1,7}$/.test(form.stockQty.trim())) errs.stockQty = "Enter a whole number";
      else stockQty = parseInt(form.stockQty, 10);
    }
    setLocal(errs);
    if (Object.keys(errs).length) return null;

    return {
      name: form.name.trim(),
      description: form.description.trim() || (editing ? null : undefined),
      kind: form.kind,
      sku: form.sku.trim() || (editing ? null : undefined),
      priceMinor,
      taxBps,
      discountType: form.discountType,
      discountValue,
      categoryId: form.categoryId || null,
      imageFileId: form.imageFileId,
      isAvailable: form.isAvailable,
      trackInventory: form.trackInventory,
      stockQty,
    };
  }

  const save = useAction(async (body: Record<string, unknown>) => {
    if (product) await api(`/api/${portal}/products/${product.id}`, { method: "PATCH", body });
    else await api(`/api/${portal}/products`, { method: "POST", body: { ...body, businessId: form.businessId } });
    toast.success(product ? "Product updated" : "Product created");
    router.refresh();
    onClose();
  });

  const submit = async () => {
    setLocal({});
    const body = validate();
    if (body) await save.run(body);
  };
  const err = (k: string) => local[k] ?? save.fieldErrors[k];

  async function onFile(file: File | undefined) {
    if (!file) return;
    setLocal((l) => ({ ...l, image: "" }));
    if (!IMAGE_TYPES.includes(file.type)) return setLocal((l) => ({ ...l, image: "Use a PNG, JPEG or WebP image" }));
    if (file.size > MAX_IMAGE_BYTES) return setLocal((l) => ({ ...l, image: "Image must be 1 MB or smaller" }));
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/${portal}/products/image`, { method: "POST", body: fd, credentials: "same-origin" });
      const json = (await res.json().catch(() => null)) as { data?: { id: string; url: string }; error?: { message: string } } | null;
      if (!res.ok || !json?.data) throw new Error(json?.error?.message ?? "Upload failed");
      setForm({ ...form, imageFileId: json.data.id, imageUrl: json.data.url });
    } catch (e) {
      setLocal((l) => ({ ...l, image: e instanceof Error ? e.message : "Upload failed" }));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const businessFixed = editing || businesses.length === 1;

  return (
    <Dialog open onClose={onClose} title={editing ? "Edit product" : "New product"} description="Prices are in rupees and saved to the paisa." size="lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {save.error && <Alert tone="error">{save.error}</Alert>}

        {!businessFixed && (
          <Select label="Business" value={form.businessId} onChange={(e) => set("businessId", e.target.value)} error={err("businessId")}>
            <option value="" disabled>Choose a business</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} error={err("name")} required />
          <Select label="Type" value={form.kind} onChange={(e) => set("kind", e.target.value as FormState["kind"])} error={err("kind")}>
            <option value="PRODUCT">Product</option>
            <option value="SERVICE">Service</option>
          </Select>
        </div>
        <Textarea label="Description" value={form.description} maxLength={1000} onChange={(e) => set("description", e.target.value)} error={err("description")} />

        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Price (INR)" inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} error={err("price") ?? err("priceMinor")} placeholder="0.00" required />
          <Input label="Tax rate (%)" inputMode="decimal" value={form.tax} onChange={(e) => set("tax", e.target.value)} error={err("tax") ?? err("taxBps")} hint="Leave empty to use the business default" />
          <Input label="SKU" value={form.sku} maxLength={64} onChange={(e) => set("sku", e.target.value)} error={err("sku")} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Discount" value={form.discountType} onChange={(e) => setForm({ ...form, discountType: e.target.value as FormState["discountType"], discountValue: "" })} error={err("discountType")}>
            <option value="NONE">None</option>
            <option value="PERCENT">Percent off</option>
            <option value="FIXED">Amount off</option>
          </Select>
          {form.discountType !== "NONE" && (
            <Input
              label={form.discountType === "PERCENT" ? "Discount (%)" : "Discount (INR)"}
              inputMode="decimal"
              value={form.discountValue}
              onChange={(e) => set("discountValue", e.target.value)}
              error={err("discountValue")}
            />
          )}
        </div>

        <div className="space-y-1.5">
          <Select label="Category" value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)} error={err("categoryId")} hint={catError ?? undefined}>
            <option value="">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>

        <div className="space-y-2">
          <span className="block text-sm font-medium text-ink">Image</span>
          <div className="flex items-center gap-4">
            <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-muted text-ink-muted">
              {form.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={form.imageUrl} alt="Product preview" className="size-full object-cover" />
              ) : (
                <ImagePlus className="size-6" aria-hidden />
              )}
            </div>
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" loading={uploading} onClick={() => fileRef.current?.click()}>
                  {form.imageUrl ? "Replace image" : "Upload image"}
                </Button>
                {form.imageUrl && (
                  <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, imageFileId: null, imageUrl: null })}>
                    <Trash2 className="size-4" />Remove
                  </Button>
                )}
              </div>
              <p className="text-xs text-ink-muted">PNG, JPEG or WebP, up to 1 MB.</p>
              {(local.image || save.fieldErrors.imageFileId) && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{local.image || save.fieldErrors.imageFileId}</p>}
            </div>
            <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(",")} className="hidden" aria-label="Product image file" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-line p-3">
          <Checkbox label="Available for sale" hint="Unavailable items stay in your list but cannot be ordered." checked={form.isAvailable} onChange={(e) => set("isAvailable", e.target.checked)} />
          <Checkbox label="Track stock" hint="Orders reduce the stock count." checked={form.trackInventory} onChange={(e) => set("trackInventory", e.target.checked)} />
          {form.trackInventory && (
            <Input label="Stock on hand" inputMode="numeric" value={form.stockQty} onChange={(e) => set("stockQty", e.target.value)} error={err("stockQty")} className="max-w-40" />
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={save.pending}>Cancel</Button>
          <Button type="submit" loading={save.pending} disabled={uploading}>{editing ? "Save changes" : "Create product"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
