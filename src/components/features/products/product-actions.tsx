"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { api, ApiError } from "@/components/shared/use-api";
import type { BusinessOption, Portal } from "./catalog-format";
import { ProductDialog, type ProductFormValue } from "./product-dialog";

export function NewProductButton({ portal, businesses }: { portal: Portal; businesses: BusinessOption[] }) {
  const [open, setOpen] = useState(false);
  if (businesses.length === 0) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="size-4" />New product</Button>
      <ProductDialog portal={portal} open={open} onClose={() => setOpen(false)} businesses={businesses} product={null} />
    </>
  );
}

export function ProductRowActions({ portal, product, businesses }: { portal: Portal; product: ProductFormValue & { archivedAt: Date | string | null }; businesses: BusinessOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const archived = Boolean(product.archivedAt);

  async function toggleAvailability() {
    setBusy(true);
    try {
      await api(`/api/${portal}/products/${product.id}/availability`, { method: "POST", body: { isAvailable: !product.isAvailable } });
      toast.success(product.isAvailable ? "Marked unavailable" : "Marked available");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not update availability");
    } finally {
      setBusy(false);
    }
  }

  async function archiveOrRestore() {
    try {
      await api(`/api/${portal}/products/${product.id}/${archived ? "restore" : "archive"}`, { method: "POST", body: {} });
      toast.success(archived ? "Product restored" : "Product archived");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not update the product");
      throw e;
    }
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      {!archived && (
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            role="switch"
            className="size-4 accent-brand-600"
            checked={product.isAvailable}
            disabled={busy}
            onChange={() => void toggleAvailability()}
            aria-label={`${product.name} is available`}
          />
          <span className="hidden sm:inline">{product.isAvailable ? "Available" : "Unavailable"}</span>
        </label>
      )}
      {!archived && (
        <Button size="sm" variant="outline" onClick={() => setEditing(true)} aria-label={`Edit ${product.name}`}>
          <Pencil className="size-4" /><span className="hidden sm:inline">Edit</span>
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`${archived ? "Restore" : "Archive"} ${product.name}`}>
        {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        <span className="hidden sm:inline">{archived ? "Restore" : "Archive"}</span>
      </Button>
      <ProductDialog portal={portal} open={editing} onClose={() => setEditing(false)} businesses={businesses} product={product} />
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        danger={!archived}
        title={archived ? "Restore this product?" : "Archive this product?"}
        description={
          archived
            ? `${product.name} will appear in your active list again.`
            : `${product.name} will be hidden from your catalogue and can no longer be ordered. Past orders keep their details. You can restore it later.`
        }
        confirmLabel={archived ? "Restore" : "Archive"}
        onConfirm={archiveOrRestore}
      />
    </div>
  );
}
