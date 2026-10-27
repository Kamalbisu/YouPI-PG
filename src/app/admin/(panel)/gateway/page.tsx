import type { Metadata } from "next";
import { Alert, Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireAdminPage } from "@/server/auth/page-guards";
import { gatewayStatus } from "@/server/services/payments";

export const metadata: Metadata = { title: "Gateway" };

export default async function GatewayPage() {
  await requireAdminPage();
  const g = gatewayStatus();
  const yes = (ok: boolean, good = "Yes", bad = "No") => <Badge tone={ok ? "green" : "amber"}>{ok ? good : bad}</Badge>;
  const rows: [string, React.ReactNode][] = [
    ["Easebuzz key and salt set", yes(g.configured)],
    ["Mode", <Badge key="m" tone={g.mode === "prod" ? "red" : "blue"}>{g.mode === "prod" ? "Live (real money)" : "Test"}</Badge>],
    ["Refund webhook token set", yes(g.webhookTokenSet)],
    ["Refund webhook hash check", g.webhookHash === "refund" ? "On" : "Off"],
    ["Callback URL", <code key="c" className="break-all text-xs">{g.callbackUrl}</code>],
    ["Refund webhook URL", <code key="w" className="break-all text-xs">{g.refundWebhookUrl}</code>],
  ];
  return (
    <>
      <PageHeader title="Payment gateway" description="Read-only. Keys are set in the server environment and are never shown here." />
      {!g.configured && <div className="mb-4"><Alert tone="warn">Online payments are off until EASEBUZZ_KEY and EASEBUZZ_SALT are set.</Alert></div>}
      <Card className="max-w-3xl">
        <CardHeader title="Easebuzz" />
        <CardBody>
          <dl className="grid grid-cols-[14rem_1fr] items-center gap-y-3 text-sm">
            {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-ink-muted">{k}</dt><dd>{v}</dd></div>))}
          </dl>
          <p className="mt-4 text-sm text-ink-muted">Give the callback URL to Easebuzz as the success and failure return address. Register the refund webhook URL in the Easebuzz dashboard and send the token in the <code>x-webhook-token</code> header, or as <code>?token=</code> on the URL.</p>
        </CardBody>
      </Card>
    </>
  );
}
