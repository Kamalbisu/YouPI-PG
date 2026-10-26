"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Input, Textarea, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export interface SettingsValues {
  platformName: string;
  supportEmail: string;
  maintenanceBanner: string;
  defaultClientPermissions: string[];
  allowClientSelfRegistration: boolean;
  orderExpiryMinutes: number;
  webhookRetentionDays: number;
}
type Perm = { key: string; description: string };

function useGroupSave(keys: (keyof SettingsValues)[], getValues: () => Partial<SettingsValues>) {
  const router = useRouter();
  const toast = useToast();
  return useAction(async () => {
    const all = getValues();
    const values = Object.fromEntries(keys.map((k) => [k, all[k]]));
    await api("/api/admin/settings", { method: "PUT", body: { values } });
    toast.success("Settings saved");
    router.refresh();
  });
}

function Footer({ pending, error, hasFieldErrors }: { pending: boolean; error: string | null; hasFieldErrors: boolean }) {
  return (
    <>
      {error && !hasFieldErrors && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end"><Button type="submit" loading={pending}>Save</Button></div>
    </>
  );
}

export function GeneralSettingsForm({ initial }: { initial: SettingsValues }) {
  const [v, setV] = useState({ platformName: initial.platformName, supportEmail: initial.supportEmail, maintenanceBanner: initial.maintenanceBanner });
  const save = useGroupSave(["platformName", "supportEmail", "maintenanceBanner"], () => v);
  const fe = save.fieldErrors ?? {};
  return (
    <Card>
      <CardHeader title="General" description="Branding, support contact and the site-wide banner." />
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} className="space-y-4">
          <Input label="Platform name" value={v.platformName} onChange={(e) => setV({ ...v, platformName: e.target.value })} error={fe.platformName} />
          <Input label="Support email" type="email" value={v.supportEmail} onChange={(e) => setV({ ...v, supportEmail: e.target.value })} error={fe.supportEmail} hint="Shown to clients as the support contact. Leave empty to hide." />
          <Textarea label="Maintenance banner" rows={3} value={v.maintenanceBanner} onChange={(e) => setV({ ...v, maintenanceBanner: e.target.value })} error={fe.maintenanceBanner} hint="Leave empty for no banner." />
          <Footer pending={save.pending} error={save.error} hasFieldErrors={Object.keys(fe).length > 0} />
        </form>
      </CardBody>
    </Card>
  );
}

export function ClientSettingsForm({ initial, permissions }: { initial: SettingsValues; permissions: Perm[] }) {
  const [perms, setPerms] = useState<string[]>(initial.defaultClientPermissions);
  const [selfReg, setSelfReg] = useState(initial.allowClientSelfRegistration);
  const save = useGroupSave(["defaultClientPermissions", "allowClientSelfRegistration"], () => ({ defaultClientPermissions: perms, allowClientSelfRegistration: selfReg }));
  const fe = save.fieldErrors ?? {};
  const toggle = (k: string) => setPerms((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  return (
    <Card>
      <CardHeader title="Clients" description="Defaults applied to new client accounts." />
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-ink">Default permissions</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {permissions.map((p) => <Checkbox key={p.key} label={p.key} hint={p.description} checked={perms.includes(p.key)} onChange={() => toggle(p.key)} />)}
            </div>
            {fe.defaultClientPermissions && <p className="text-xs text-red-600">{fe.defaultClientPermissions}</p>}
          </fieldset>
          <Checkbox label="Allow client self-registration" hint="When off, only admins can create client accounts." checked={selfReg} onChange={(e) => setSelfReg(e.target.checked)} />
          <Footer pending={save.pending} error={save.error} hasFieldErrors={Object.keys(fe).length > 0} />
        </form>
      </CardBody>
    </Card>
  );
}

export function OperationsSettingsForm({ initial }: { initial: SettingsValues }) {
  const [v, setV] = useState({ orderExpiryMinutes: String(initial.orderExpiryMinutes), webhookRetentionDays: String(initial.webhookRetentionDays) });
  const save = useGroupSave(["orderExpiryMinutes", "webhookRetentionDays"], () => ({
    orderExpiryMinutes: Number(v.orderExpiryMinutes) as number,
    webhookRetentionDays: Number(v.webhookRetentionDays) as number,
  }));
  const fe = save.fieldErrors ?? {};
  return (
    <Card>
      <CardHeader title="Orders and webhooks" description="How long unpaid orders stay open and how long webhook logs are kept." />
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Order expiry (minutes)" type="number" inputMode="numeric" min={5} max={1440} value={v.orderExpiryMinutes} onChange={(e) => setV({ ...v, orderExpiryMinutes: e.target.value })} error={fe.orderExpiryMinutes} hint="Between 5 and 1440." />
            <Input label="Webhook log retention (days)" type="number" inputMode="numeric" min={7} max={3650} value={v.webhookRetentionDays} onChange={(e) => setV({ ...v, webhookRetentionDays: e.target.value })} error={fe.webhookRetentionDays} hint="Between 7 and 3650." />
          </div>
          <Footer pending={save.pending} error={save.error} hasFieldErrors={Object.keys(fe).length > 0} />
        </form>
      </CardBody>
    </Card>
  );
}
