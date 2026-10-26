"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Alert, Button, ConfirmDialog, DataTable, Dialog, Input, Select, useToast } from "@/components/ui";
import { api, ApiError, useAction } from "@/components/shared/use-api";
import type { BusinessOption, Portal } from "./catalog-format";

export interface CategoryRow {
  id: string;
  businessId: string;
  businessName: string;
  name: string;
  sortOrder: number;
  productCount: number;
}

function CategoryDialog({ portal, open, onClose, businesses, category }: {
  portal: Portal; open: boolean; onClose: () => void; businesses: BusinessOption[]; category: CategoryRow | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [businessId, setBusinessId] = useState(category?.businessId ?? businesses[0]?.id ?? "");
  const [name, setName] = useState(category?.name ?? "");
  const [sort, setSort] = useState(String(category?.sortOrder ?? 0));
  const [local, setLocal] = useState<Record<string, string>>({});

  const save = useAction(async (body: Record<string, unknown>) => {
    if (category) await api(`/api/${portal}/categories/${category.id}`, { method: "PATCH", body });
    else await api(`/api/${portal}/categories`, { method: "POST", body: { ...body, businessId } });
    toast.success(category ? "Category updated" : "Category added");
    router.refresh();
    onClose();
  });

  function submit() {
    const errs: Record<string, string> = {};
    if (!businessId) errs.businessId = "Choose a business";
    if (name.trim().length < 2) errs.name = "Enter at least 2 characters";
    if (!/^\d{1,5}$/.test(sort.trim()) || parseInt(sort, 10) > 10000) errs.sortOrder = "Enter a whole number from 0 to 10000";
    setLocal(errs);
    if (Object.keys(errs).length) return;
    void save.run({ name: name.trim(), sortOrder: parseInt(sort, 10) });
  }
  const err = (k: string) => local[k] ?? save.fieldErrors[k];

  return (
    <Dialog open={open} onClose={onClose} title={category ? "Edit category" : "New category"} description="Categories group products on your catalogue.">
      {open && (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {save.error && <Alert tone="error">{save.error}</Alert>}
          {!category && businesses.length > 1 && (
            <Select label="Business" value={businessId} onChange={(e) => setBusinessId(e.target.value)} error={err("businessId")}>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          )}
          <Input label="Name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} error={err("name")} autoFocus />
          <Input label="Sort order" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} error={err("sortOrder")} hint="Lower numbers appear first" className="max-w-40" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={save.pending}>Cancel</Button>
            <Button type="submit" loading={save.pending}>{category ? "Save changes" : "Add category"}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function NewCategoryButton({ portal, businesses }: { portal: Portal; businesses: BusinessOption[] }) {
  const [open, setOpen] = useState(false);
  if (businesses.length === 0) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="size-4" />New category</Button>
      {open && <CategoryDialog portal={portal} open onClose={() => setOpen(false)} businesses={businesses} category={null} />}
    </>
  );
}

export function CategoryTable({ portal, rows, showBusiness, businesses, emptyAction }: {
  portal: Portal; rows: CategoryRow[]; showBusiness: boolean; businesses: BusinessOption[]; emptyAction?: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [deleting, setDeleting] = useState<CategoryRow | null>(null);

  async function remove(c: CategoryRow) {
    try {
      const res = await api<{ productsUncategorised: number }>(`/api/${portal}/categories/${c.id}`, { method: "DELETE" });
      toast.success(res.productsUncategorised > 0 ? `Category deleted. ${res.productsUncategorised} product(s) are now uncategorised.` : "Category deleted");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not delete the category");
      throw e;
    }
  }

  return (
    <>
      <DataTable
        rows={rows}
        rowKey={(c) => c.id}
        empty={{ title: "No categories yet", description: "Add a category to group your products.", action: emptyAction }}
        columns={[
          { key: "name", header: "Category", cell: (c) => <span className="font-medium">{c.name}</span> },
          ...(showBusiness ? [{ key: "biz", header: "Business", cell: (c: CategoryRow) => c.businessName }] : []),
          { key: "count", header: "Products", align: "right" as const, cell: (c) => c.productCount },
          { key: "sort", header: "Sort order", align: "right" as const, cell: (c) => c.sortOrder },
          {
            key: "actions",
            header: "",
            align: "right" as const,
            cell: (c) => (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}><Pencil className="size-4" /><span className="hidden sm:inline">Edit</span></Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}><Trash2 className="size-4" /><span className="hidden sm:inline">Delete</span></Button>
              </div>
            ),
          },
        ]}
      />
      {editing && <CategoryDialog key={editing.id} portal={portal} open onClose={() => setEditing(null)} businesses={businesses} category={editing} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        danger
        title="Delete this category?"
        description={deleting ? `${deleting.name} will be removed. Its ${deleting.productCount} product(s) are kept and become uncategorised.` : ""}
        confirmLabel="Delete"
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </>
  );
}
