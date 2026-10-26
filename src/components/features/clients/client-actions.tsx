"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { KeyRound, Pause, Play } from "lucide-react";
import { Alert, Button, Dialog, Select, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import { InviteLinkBox } from "./invite-link-box";
import { ReasonDialog } from "./reason-dialog";

export function ClientStatusActions({ clientId, status }: { clientId: string; status: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<"suspend" | "reactivate" | null>(null);
  return (
    <>
      {status === "ACTIVE" ? (
        <Button variant="danger" onClick={() => setOpen("suspend")}><Pause className="size-4" />Suspend</Button>
      ) : (
        <Button onClick={() => setOpen("reactivate")}><Play className="size-4" />Reactivate</Button>
      )}
      <ReasonDialog
        open={open === "suspend"}
        onClose={() => setOpen(null)}
        title="Suspend this client?"
        description="All users of this client are signed out immediately and cannot sign in until the account is reactivated."
        confirmLabel="Suspend client"
        danger
        onSubmit={async (reason) => {
          await api(`/api/admin/clients/${clientId}/suspend`, { method: "POST", body: { reason } });
          toast.success("Client suspended");
          router.refresh();
        }}
      />
      <ReasonDialog
        open={open === "reactivate"}
        onClose={() => setOpen(null)}
        title="Reactivate this client?"
        description="Users will be able to sign in again."
        confirmLabel="Reactivate"
        required={false}
        onSubmit={async (reason) => {
          await api(`/api/admin/clients/${clientId}/reactivate`, { method: "POST", body: { reason: reason || undefined } });
          toast.success("Client reactivated");
          router.refresh();
        }}
      />
    </>
  );
}

type ResetResult = { link: string; purpose: "INVITE" | "PASSWORD_RESET"; emailStatus: string };

export function ResetPasswordButton({ clientId, users }: { clientId: string; users: { id: string; email: string; status: string }[] }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  const [result, setResult] = useState<ResetResult | null>(null);
  const a = useAction(async () => {
    const r = await api<ResetResult>(`/api/admin/clients/${clientId}/reset-password`, { method: "POST", body: { userId } });
    setResult(r);
    toast.success(r.purpose === "INVITE" ? "New invitation prepared" : "Password reset started");
  });
  if (users.length === 0) return null;
  const close = () => { setOpen(false); setResult(null); };
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}><KeyRound className="size-4" />Reset password</Button>
      <Dialog
        open={open}
        onClose={close}
        title={result ? (result.purpose === "INVITE" ? "Invitation link" : "Password reset link") : "Reset password"}
        description={result ? undefined : "The user is signed out everywhere and receives a one-time link. You will also see the link here once."}
      >
        {result ? (
          <div className="space-y-4">
            <InviteLinkBox link={result.link} emailStatus={result.emailStatus} purpose={result.purpose} />
            <div className="flex justify-end"><Button onClick={close}>Done</Button></div>
          </div>
        ) : (
          <div className="space-y-4">
            {a.error && <Alert tone="error">{a.error}</Alert>}
            {users.length > 1 && (
              <Select label="User" value={userId} onChange={(e) => setUserId(e.target.value)}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
              </Select>
            )}
            {users.length === 1 && <p className="text-sm text-ink-muted">User: {users[0].email}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={close} disabled={a.pending}>Cancel</Button>
              <Button loading={a.pending} onClick={() => void a.run()}>Reset password</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
