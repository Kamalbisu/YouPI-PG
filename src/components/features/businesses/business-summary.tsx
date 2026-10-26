import { Card, CardBody, CardHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

type B = {
  businessCode: string; category: string; description: string | null; addressLine: string | null; city: string | null; state: string | null; pincode: string | null;
  contactPhone: string | null; contactEmail: string | null; ownerName: string | null; ownerPhone: string | null; hoursText: string | null;
  acceptingOrders: boolean; pricesIncludeTax: boolean; defaultTaxBps: number; allowCustomAmount: boolean; currency: string; createdAt: Date;
  staticUpiVpa?: string | null;
};

const dash = (v: string | null | undefined) => (v && v.trim() ? v : "-");

/** Read-only profile of a business (used on the admin page). */
export function BusinessSummary({ b }: { b: B }) {
  const address = [b.addressLine, b.city, b.state, b.pincode].filter(Boolean).join(", ");
  const rows: [string, string][] = [
    ["Code", b.businessCode],
    ["Category", b.category],
    ["Address", dash(address)],
    ["Phone", dash(b.contactPhone)],
    ["Email", dash(b.contactEmail)],
    ["Owner", dash([b.ownerName, b.ownerPhone].filter(Boolean).join(", "))],
    ["Hours", dash(b.hoursText)],
    ["Accepting orders", b.acceptingOrders ? "Yes" : "No"],
    ["Prices include tax", b.pricesIncludeTax ? "Yes" : "No"],
    ["Default tax", `${b.defaultTaxBps / 100}%`],
    ["Custom amount", b.allowCustomAmount ? "Allowed" : "Not allowed"],
    ["Currency", b.currency],
    ["Created", formatDateTime(b.createdAt)],
  ];
  return (
    <Card>
      <CardHeader title="Profile" />
      <CardBody>
        {b.description && <p className="mb-4 text-sm text-ink-muted">{b.description}</p>}
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([k, v]) => (<div key={k}><dt className="text-ink-muted">{k}</dt><dd className="break-words">{v}</dd></div>))}
        </dl>
      </CardBody>
    </Card>
  );
}
