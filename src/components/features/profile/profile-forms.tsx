"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Input, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export function EditProfileForm({ name, phone, email }: { name: string; phone: string; email: string }) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState({ name, phone });
  const save = useAction(async () => {
    await api("/api/client/profile", { method: "PATCH", body: v });
    toast.success("Profile updated");
    router.refresh();
  });
  const fe = save.fieldErrors ?? {};
  return (
    <Card>
      <CardHeader title="Your details" />
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} className="space-y-4">
          <Input label="Email" value={email} disabled readOnly hint="Your email is your login and cannot be changed here." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={fe.name} required />
            <Input label="Phone" type="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} error={fe.phone} />
          </div>
          {save.error && !Object.keys(fe).length && <Alert tone="error">{save.error}</Alert>}
          <div className="flex justify-end"><Button type="submit" loading={save.pending}>Save changes</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}

export function ChangePasswordForm() {
  const toast = useToast();
  const [v, setV] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [localErr, setLocalErr] = useState<string | null>(null);
  const save = useAction(async () => {
    if (v.newPassword !== v.confirm) {
      setLocalErr("The new passwords do not match");
      return;
    }
    setLocalErr(null);
    await api("/api/auth/password", { method: "POST", body: { currentPassword: v.currentPassword, newPassword: v.newPassword } });
    setV({ currentPassword: "", newPassword: "", confirm: "" });
    toast.success("Password changed");
  });
  const fe = save.fieldErrors ?? {};
  return (
    <Card>
      <CardHeader title="Password" description="Use at least 12 characters." />
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); void save.run(); }} className="space-y-4">
          <Input label="Current password" type="password" autoComplete="current-password" value={v.currentPassword} onChange={(e) => setV({ ...v, currentPassword: e.target.value })} error={fe.currentPassword} required />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="New password" type="password" autoComplete="new-password" value={v.newPassword} onChange={(e) => setV({ ...v, newPassword: e.target.value })} error={fe.newPassword} required />
            <Input label="Confirm new password" type="password" autoComplete="new-password" value={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.value })} required />
          </div>
          {(localErr || (save.error && !Object.keys(fe).length)) && <Alert tone="error">{localErr ?? save.error}</Alert>}
          <div className="flex justify-end"><Button type="submit" loading={save.pending}>Change password</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}

function QrImage({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(uri, { margin: 1, width: 192 }).then((s) => { if (live) setSrc(s); }).catch(() => { if (live) setSrc(null); });
    return () => { live = false; };
  }, [uri]);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="QR code to scan with your authenticator app" width={192} height={192} className="rounded border border-line bg-white" /> : <div className="size-48 animate-pulse rounded bg-surface-muted" aria-hidden />;
}

/** Two-factor setup: shows the QR and secret only while enrolling; the secret is never stored in the page afterwards. */
export function TwoFactorCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState("");
  const start = useAction(async () => { setSetup(await api<{ secret: string; otpauthUri: string }>("/api/auth/2fa/setup", { method: "POST" })); });
  const confirm = useAction(async () => {
    await api("/api/auth/2fa/confirm", { method: "POST", body: { code } });
    setSetup(null);
    setCode("");
    toast.success("Two-factor authentication is on");
    router.refresh();
  });
  return (
    <Card>
      <CardHeader title="Two-factor authentication" description="Require a code from an authenticator app when you sign in." action={<Badge tone={enabled ? "green" : "gray"}>{enabled ? "On" : "Off"}</Badge>} />
      <CardBody className="space-y-4">
        {!enabled && !setup && (
          <>
            {start.error && <Alert tone="error">{start.error}</Alert>}
            <Button onClick={() => void start.run()} loading={start.pending}>Set up two-factor</Button>
          </>
        )}
        {!enabled && setup && (
          <form onSubmit={(e) => { e.preventDefault(); void confirm.run(); }} className="space-y-4">
            <p className="text-sm text-ink-muted">Scan this code with an authenticator app, then enter the 6 digit code it shows.</p>
            <div className="flex flex-wrap items-start gap-4">
              <QrImage uri={setup.otpauthUri} />
              <div className="min-w-0 space-y-1 text-sm">
                <p className="text-ink-muted">Cannot scan? Enter this key manually:</p>
                <code className="block break-all rounded bg-surface-muted px-2 py-1 text-xs">{setup.secret}</code>
              </div>
            </div>
            <Input label="6 digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} error={confirm.fieldErrors?.code} required />
            {confirm.error && !confirm.fieldErrors?.code && <Alert tone="error">{confirm.error}</Alert>}
            <div className="flex gap-2">
              <Button type="submit" loading={confirm.pending} disabled={code.length !== 6}>Turn on</Button>
              <Button type="button" variant="ghost" onClick={() => { setSetup(null); setCode(""); }}>Cancel</Button>
            </div>
          </form>
        )}
        {enabled && <Button variant="danger" onClick={() => setDisableOpen(true)}>Turn off</Button>}
      </CardBody>
      <Dialog open={disableOpen && enabled} onClose={() => { setDisableOpen(false); setPassword(""); }} title="Turn off two-factor?" description="Enter your password to confirm.">
        <DisableForm password={password} setPassword={setPassword} onDone={() => { setDisableOpen(false); setPassword(""); toast.success("Two-factor authentication is off"); router.refresh(); }} onCancel={() => { setDisableOpen(false); setPassword(""); }} />
      </Dialog>
    </Card>
  );
}

function DisableForm({ password, setPassword, onDone, onCancel }: { password: string; setPassword: (s: string) => void; onDone: () => void; onCancel: () => void }) {
  const dis = useAction(async () => {
    await api("/api/auth/2fa/disable", { method: "POST", body: { password } });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void dis.run(); }} className="space-y-4">
      <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={dis.fieldErrors?.password} required />
      {dis.error && !dis.fieldErrors?.password && <Alert tone="error">{dis.error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="danger" loading={dis.pending} disabled={!password}>Turn off</Button>
      </div>
    </form>
  );
}

