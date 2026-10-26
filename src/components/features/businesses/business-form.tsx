"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Input, Textarea, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export interface BusinessFormValues {
  name: string; category: string; description: string; addressLine: string; city: string; state: string; pincode: string;
  contactPhone: string; contactEmail: string; ownerName: string; ownerPhone: string; hoursText: string;
  acceptingOrders: boolean; pricesIncludeTax: boolean; defaultTaxPercent: string; allowCustomAmount: boolean;
}

export const EMPTY_BUSINESS: BusinessFormValues = {
  name: "", category: "", description: "", addressLine: "", city: "", state: "", pincode: "", contactPhone: "", contactEmail: "",
  ownerName: "", ownerPhone: "", hoursText: "", acceptingOrders: true, pricesIncludeTax: false, defaultTaxPercent: "0", allowCustomAmount: false,
};

/** Basis points to a percent string for the form ("1800" -> "18"). */
export function bpsToPercent(bps: number | null | undefined) {
  return String((bps ?? 0) / 100);
}

function toBody(f: BusinessFormValues) {
  const { defaultTaxPercent, ...rest } = f;
  const pct = Number(defaultTaxPercent);
  return { ...rest, defaultTaxBps: Number.isFinite(pct) ? Math.round(pct * 100) : NaN };
}

/** Create (no id) or edit (id) a business profile. Currency is fixed to INR. */
export function BusinessForm({ businessId, initial, readOnly }: { businessId?: string; initial?: BusinessFormValues; readOnly?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState<BusinessFormValues>(initial ?? EMPTY_BUSINESS);
  const set = (k: keyof BusinessFormValues) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const flag = (k: "acceptingOrders" | "pricesIncludeTax" | "allowCustomAmount") => (e: { target: { checked: boolean } }) => setF({ ...f, [k]: e.target.checked });
  const a = useAction(async () => {
    if (businessId) {
      await api(`/api/client/businesses/${businessId}`, { method: "PATCH", body: toBody(f) });
      toast.success("Business updated");
      router.refresh();
    } else {
      const b = await api<{ id: string }>("/api/client/businesses", { method: "POST", body: toBody(f) });
      toast.success("Business submitted for approval");
      router.push(`/client/businesses/${b.id}`);
      router.refresh();
    }
  });
  const err = a.fieldErrors;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void a.run(); }} noValidate className="space-y-6">
      {a.error && <Alert tone="error">{a.error}</Alert>}
      <Card>
        <CardHeader title="Business details" description="Shown to customers on the payment page." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input label="Business name" required disabled={readOnly} value={f.name} onChange={set("name")} error={err.name} />
          <Input label="Category" required disabled={readOnly} value={f.category} onChange={set("category")} error={err.category} hint="For example Cafe, Salon, Retail." />
          <div className="sm:col-span-2"><Textarea label="Description" disabled={readOnly} value={f.description} onChange={set("description")} error={err.description} /></div>
          <div className="sm:col-span-2"><Input label="Address" disabled={readOnly} value={f.addressLine} onChange={set("addressLine")} error={err.addressLine} /></div>
          <Input label="City" disabled={readOnly} value={f.city} onChange={set("city")} error={err.city} />
          <Input label="State" disabled={readOnly} value={f.state} onChange={set("state")} error={err.state} />
          <Input label="Pincode" disabled={readOnly} inputMode="numeric" value={f.pincode} onChange={set("pincode")} error={err.pincode} />
          <Input label="Opening hours" disabled={readOnly} value={f.hoursText} onChange={set("hoursText")} error={err.hoursText} hint="For example Mon-Sat 9:00 to 21:00." />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Contact" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input label="Business phone" type="tel" disabled={readOnly} value={f.contactPhone} onChange={set("contactPhone")} error={err.contactPhone} />
          <Input label="Business email" type="email" disabled={readOnly} value={f.contactEmail} onChange={set("contactEmail")} error={err.contactEmail} />
          <Input label="Owner name" disabled={readOnly} value={f.ownerName} onChange={set("ownerName")} error={err.ownerName} />
          <Input label="Owner phone" type="tel" disabled={readOnly} value={f.ownerPhone} onChange={set("ownerPhone")} error={err.ownerPhone} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Pricing and orders" description="Currency is INR." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input label="Default tax (%)" type="number" min={0} max={100} step="0.01" disabled={readOnly} value={f.defaultTaxPercent} onChange={set("defaultTaxPercent")} error={err.defaultTaxBps} />
          <div />
          <Checkbox label="Accepting orders" hint="Turn off to pause new orders without closing the business." disabled={readOnly} checked={f.acceptingOrders} onChange={flag("acceptingOrders")} />
          <Checkbox label="Prices include tax" hint="Product prices already contain the default tax." disabled={readOnly} checked={f.pricesIncludeTax} onChange={flag("pricesIncludeTax")} />
          <Checkbox label="Allow custom amount" hint="Customers may pay an amount they enter." disabled={readOnly} checked={f.allowCustomAmount} onChange={flag("allowCustomAmount")} />
        </CardBody>
      </Card>
      {!readOnly && (
        <div className="flex gap-2">
          <Button type="submit" loading={a.pending}>{businessId ? "Save changes" : "Submit for approval"}</Button>
          {!businessId && <Link href="/client/businesses" className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm font-medium hover:bg-surface-muted">Cancel</Link>}
        </div>
      )}
    </form>
  );
}
