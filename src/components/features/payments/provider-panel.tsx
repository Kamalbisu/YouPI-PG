"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, ConfirmDialog, Input, Select, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import { formatDateTime } from "@/lib/utils";

export interface ProviderConfigProps {
  id: string | null;
  businessId: string;
  provider: "RAZORPAY" | "CASHFREE";
  mode: "TEST" | "LIVE";
  isActive: boolean;
  keyIdMasked: string | null;
  hasSecret: boolean;
  hasWebhookSecret: boolean;
  merchantLabel: string | null;
  methods: string[];
  lastVerifiedAt: string | null;
  webhookUrl: string | null;
  usesPlatformCredentials: boolean;
}

const PROVIDER_NAME = { RAZORPAY: "Razorpay", CASHFREE: "Cashfree" } as const;

/** Admin-only editor for one provider of one business. Secrets are write-only: the server never returns them. */
export function ProviderPanel({ config, methodLabels }: { config: ProviderConfigProps; methodLabels: Record<string, string> }) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState(config.mode);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [label, setLabel] = useState(config.merchantLabel ?? "");
  const [methods, setMethods] = useState<string[]>(config.methods);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const name = PROVIDER_NAME[config.provider];
  const configured = config.id !== null;

  const save = useAction(async () => {
    await api("/api/admin/payment-config", {
      method: "POST",
      body: {
        businessId: config.businessId,
        provider: config.provider,
        mode,
        ...(keyId.trim() ? { keyId: keyId.trim() } : {}),
        ...(secret ? { secret } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
        merchantLabel: label.trim(),
        ...(configured ? {} : { methods }),
      },
    });
    setKeyId("");
    setSecret("");
    setWebhookSecret("");
    setVerifyMsg(null);
    toast.success("Credentials saved. Verify them, then activate.");
    router.refresh();
  });

  const saveMethods = useAction(async () => {
    await api(`/api/admin/payment-config/${config.id}/methods`, { method: "POST", body: { methods } });
    toast.success("Payment methods updated");
    router.refresh();
  });

  const verify = useAction(async () => {
    const r = await api<{ ok: boolean; message: string }>(`/api/admin/payment-config/${config.id}/verify`, { method: "POST" });
    setVerifyMsg({ ok: r.ok, text: r.message });
    if (r.ok) toast.success("Credentials verified");
    router.refresh();
  });

  const toggle = useAction(async (active: boolean) => {
    await api(`/api/admin/payment-config/${config.id}/active`, { method: "POST", body: { active } });
    toast.success(active ? `${name} activated` : `${name} deactivated`);
    router.refresh();
  });

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(config.webhookUrl ?? "");
      toast.success("Webhook URL copied");
    } catch {
      toast.error("Could not copy. Select the URL and copy it manually.");
    }
  };

  const methodsDirty = methods.slice().sort().join() !== config.methods.slice().sort().join();
  const err = save.error ?? saveMethods.error ?? verify.error ?? toggle.error;

  return (
    <Card>
      <CardHeader
        title={name}
        description={configured ? `Merchant account${config.merchantLabel ? `: ${config.merchantLabel}` : ""}` : config.usesPlatformCredentials ? "Customers are served with the platform credentials until you add this business's own." : "Not configured."}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {configured && <Badge tone={config.mode === "LIVE" ? "blue" : "gray"}>{config.mode === "LIVE" ? "Live" : "Test"}</Badge>}
            {configured && <Badge tone={config.isActive ? "green" : "gray"}>{config.isActive ? "Active" : "Inactive"}</Badge>}
            {!configured && config.usesPlatformCredentials && <Badge tone="amber">Platform credentials</Badge>}
          </div>
        }
      />
      <CardBody className="space-y-5">
        {err && <Alert tone="error">{err}</Alert>}
        {verifyMsg && <Alert tone={verifyMsg.ok ? "success" : "error"}>{verifyMsg.ok ? "The provider accepted these credentials." : `The provider rejected these credentials: ${verifyMsg.text}`}</Alert>}

        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => { e.preventDefault(); void save.run(); }}
          noValidate
        >
          <Select label="Mode" value={mode} onChange={(e) => setMode(e.target.value as "TEST" | "LIVE")} hint="Live mode must be verified before it can be activated.">
            <option value="TEST">Test</option>
            <option value="LIVE">Live</option>
          </Select>
          <Input label="Account label" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} error={save.fieldErrors.merchantLabel} hint="Only shown to admins" />
          <Input
            label="Key id"
            value={keyId}
            autoComplete="off"
            onChange={(e) => setKeyId(e.target.value)}
            error={save.fieldErrors.keyId}
            placeholder={config.keyIdMasked ?? ""}
            hint={config.keyIdMasked ? `Saved as ${config.keyIdMasked}. Leave blank to keep it.` : "Required"}
          />
          <Input
            label="Key secret"
            type="password"
            value={secret}
            autoComplete="new-password"
            onChange={(e) => setSecret(e.target.value)}
            error={save.fieldErrors.secret}
            placeholder={config.hasSecret ? "Saved" : ""}
            hint={config.hasSecret ? "Stored encrypted and never shown again. Leave blank to keep it." : "Stored encrypted and never shown again."}
          />
          <Input
            label="Webhook secret"
            type="password"
            value={webhookSecret}
            autoComplete="new-password"
            onChange={(e) => setWebhookSecret(e.target.value)}
            error={save.fieldErrors.webhookSecret}
            placeholder={config.hasWebhookSecret ? "Saved" : ""}
            hint={config.hasWebhookSecret ? "Leave blank to keep the saved one." : "Needed to accept this provider's webhooks."}
          />
          <div className="flex items-end">
            <Button type="submit" loading={save.pending}><KeyRound className="size-4" aria-hidden />{configured ? "Save credentials" : "Add credentials"}</Button>
          </div>
        </form>
        {configured && <p className="text-xs text-ink-muted">Changing the key, secret or mode deactivates this configuration until it is verified and activated again.</p>}

        {config.webhookUrl && (
          <div>
            <p className="text-sm font-medium text-ink">Webhook URL</p>
            <p className="mt-0.5 text-xs text-ink-muted">Add this in the {name} dashboard so payment events reach YouPI.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs">{config.webhookUrl}</code>
              <Button variant="outline" size="sm" onClick={copyUrl}><Copy className="size-4" aria-hidden />Copy</Button>
            </div>
          </div>
        )}

        {configured && (
          <>
            <fieldset className="space-y-2.5">
              <legend className="text-sm font-medium text-ink">Methods offered to customers</legend>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {Object.entries(methodLabels).map(([key, text]) => (
                  <Checkbox
                    key={key}
                    label={text}
                    checked={methods.includes(key)}
                    onChange={(e) => setMethods(e.target.checked ? [...methods, key] : methods.filter((m) => m !== key))}
                  />
                ))}
              </div>
              <Button variant="outline" size="sm" disabled={!methodsDirty} loading={saveMethods.pending} onClick={() => void saveMethods.run()}>Save methods</Button>
            </fieldset>

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button variant="outline" size="sm" loading={verify.pending} disabled={!config.hasSecret} onClick={() => void verify.run()}>Verify credentials</Button>
              {config.isActive ? (
                <Button variant="outline" size="sm" loading={toggle.pending} onClick={() => void toggle.run(false)}>Deactivate</Button>
              ) : (
                <Button size="sm" loading={toggle.pending} onClick={() => void toggle.run(true)}>Activate</Button>
              )}
              <Button variant="ghost" size="sm" className="text-red-600" onClick={() => setConfirmDelete(true)}>Delete</Button>
              <span className="ml-auto text-xs text-ink-muted">{config.lastVerifiedAt ? `Verified ${formatDateTime(config.lastVerifiedAt)}` : "Not verified yet"}</span>
            </div>
          </>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${name} configuration?`}
        description="The saved credentials are removed. A configuration that has payment history cannot be deleted; deactivate it instead."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          await api(`/api/admin/payment-config/${config.id}`, { method: "DELETE" });
          toast.success("Configuration deleted");
          setConfirmDelete(false);
          router.refresh();
        }}
      />
    </Card>
  );
}
