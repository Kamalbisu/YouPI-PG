"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, ButtonLink, Card, CardBody, CardHeader, Checkbox, Input, Textarea, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import { InviteLinkBox } from "./invite-link-box";

export interface PermissionOption { key: string; label: string; ownerOnly?: boolean }

export function PermissionChecklist({ options, value, onChange, disabled }: { options: PermissionOption[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {options.map((o) => (
        <Checkbox
          key={o.key}
          label={o.key}
          hint={o.label + (o.ownerOnly ? " (account owner only)" : "")}
          checked={value.includes(o.key)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? [...value, o.key] : value.filter((k) => k !== o.key))}
        />
      ))}
    </div>
  );
}

export function CreateClientForm({ permissionOptions, defaultPermissions }: { permissionOptions: PermissionOption[]; defaultPermissions: string[] }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", contactName: "", email: "", phone: "", address: "", notes: "", maxBusinesses: "1" });
  const [perms, setPerms] = useState<string[]>(defaultPermissions);
  const [result, setResult] = useState<{ clientId: string; link: string; emailStatus: string; email: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const a = useAction(async () => {
    const r = await api<{ client: { id: string }; user: { email: string }; inviteLink: string; emailStatus: string }>("/api/admin/clients", {
      method: "POST",
      body: { ...f, maxBusinesses: Number(f.maxBusinesses), permissions: perms },
    });
    toast.success("Client created");
    setResult({ clientId: r.client.id, link: r.inviteLink, emailStatus: r.emailStatus, email: r.user.email });
  });

  if (result) {
    return (
      <Card>
        <CardHeader title="Client created" description={`An invitation was prepared for ${result.email}.`} />
        <CardBody className="space-y-5">
          <InviteLinkBox link={result.link} emailStatus={result.emailStatus} purpose="INVITE" />
          <div className="flex gap-2">
            <ButtonLink href={`/admin/clients/${result.clientId}`}>Open client</ButtonLink>
            <ButtonLink href="/admin/clients" variant="outline">Back to clients</ButtonLink>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void a.run(); }} noValidate className="space-y-6">
      {a.error && <Alert tone="error">{a.error}</Alert>}
      <Card>
        <CardHeader title="Account holder" description="This person receives the invitation and signs in to the client portal." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input label="Client or company name" required value={f.name} onChange={set("name")} error={a.fieldErrors.name} />
          <Input label="Contact person" required value={f.contactName} onChange={set("contactName")} error={a.fieldErrors.contactName} />
          <Input label="Email" type="email" required autoComplete="off" value={f.email} onChange={set("email")} error={a.fieldErrors.email} hint="Also used as the sign-in email." />
          <Input label="Phone" type="tel" value={f.phone} onChange={set("phone")} error={a.fieldErrors.phone} />
          <div className="sm:col-span-2"><Input label="Address" value={f.address} onChange={set("address")} error={a.fieldErrors.address} /></div>
          <div className="sm:col-span-2"><Textarea label="Internal notes" value={f.notes} onChange={set("notes")} error={a.fieldErrors.notes} hint="Visible to administrators only." /></div>
          <Input label="Maximum businesses" type="number" min={1} max={100} value={f.maxBusinesses} onChange={set("maxBusinesses")} error={a.fieldErrors.maxBusinesses} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Permissions" description="What this client can do. You can change these later." />
        <CardBody><PermissionChecklist options={permissionOptions} value={perms} onChange={setPerms} /></CardBody>
      </Card>
      <div className="flex gap-2">
        <Button type="submit" loading={a.pending}>Create client and send invite</Button>
        <Link href="/admin/clients" className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm font-medium hover:bg-surface-muted">Cancel</Link>
      </div>
    </form>
  );
}

export function EditClientForm({ client }: { client: { id: string; name: string; contactName: string; phone: string | null; address: string | null; notes: string | null; maxBusinesses: number } }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState({ name: client.name, contactName: client.contactName, phone: client.phone ?? "", address: client.address ?? "", notes: client.notes ?? "", maxBusinesses: String(client.maxBusinesses) });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const a = useAction(async () => {
    await api(`/api/admin/clients/${client.id}`, { method: "PATCH", body: { ...f, maxBusinesses: Number(f.maxBusinesses) } });
    toast.success("Client updated");
    router.refresh();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void a.run(); }} noValidate>
      <Card>
        <CardHeader title="Client details" />
        <CardBody className="space-y-4">
          {a.error && <Alert tone="error">{a.error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Client or company name" required value={f.name} onChange={set("name")} error={a.fieldErrors.name} />
            <Input label="Contact person" required value={f.contactName} onChange={set("contactName")} error={a.fieldErrors.contactName} />
            <Input label="Phone" type="tel" value={f.phone} onChange={set("phone")} error={a.fieldErrors.phone} />
            <Input label="Maximum businesses" type="number" min={1} max={100} value={f.maxBusinesses} onChange={set("maxBusinesses")} error={a.fieldErrors.maxBusinesses} />
            <div className="sm:col-span-2"><Input label="Address" value={f.address} onChange={set("address")} error={a.fieldErrors.address} /></div>
            <div className="sm:col-span-2"><Textarea label="Internal notes" value={f.notes} onChange={set("notes")} error={a.fieldErrors.notes} /></div>
          </div>
          <Button type="submit" loading={a.pending}>Save changes</Button>
        </CardBody>
      </Card>
    </form>
  );
}

export function PermissionsEditor({ clientId, options, initial }: { clientId: string; options: PermissionOption[]; initial: string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [perms, setPerms] = useState(initial);
  const a = useAction(async () => {
    await api(`/api/admin/clients/${clientId}/permissions`, { method: "PUT", body: { permissions: perms } });
    toast.success("Permissions saved");
    router.refresh();
  });
  const dirty = JSON.stringify([...perms].sort()) !== JSON.stringify([...initial].sort());
  return (
    <Card>
      <CardHeader title="Permissions" description="Changes apply on the client's next request." />
      <CardBody className="space-y-4">
        {a.error && <Alert tone="error">{a.error}</Alert>}
        <PermissionChecklist options={options} value={perms} onChange={setPerms} />
        <Button onClick={() => void a.run()} loading={a.pending} disabled={!dirty}>Save permissions</Button>
      </CardBody>
    </Card>
  );
}
