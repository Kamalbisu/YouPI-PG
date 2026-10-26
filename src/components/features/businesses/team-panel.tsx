"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Mail, Trash2, UserPlus } from "lucide-react";
import { Alert, Badge, Button, ConfirmDialog, Dialog, Input, StatusBadge, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";
import { InviteLinkBox } from "@/components/features/clients/invite-link-box";
import { formatDateTime } from "@/lib/utils";

export interface TeamRow { id: string; name: string; email: string; role: string; status: string; lastLoginAt: Date | string | null }
type Invite = { link: string; emailStatus: string; email: string };

/** Owner-only team management: add or remove managers, who can see only this business. */
export function TeamPanel({ businessId, members, currentUserId }: { businessId: string; members: TeamRow[]; currentUserId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", email: "", phone: "" });
  const [invite, setInvite] = useState<Invite | null>(null);
  const [removing, setRemoving] = useState<TeamRow | null>(null);

  const add = useAction(async () => {
    const r = await api<{ member: { email: string }; inviteLink: string; emailStatus: string }>(`/api/client/businesses/${businessId}/team`, { method: "POST", body: f });
    toast.success("Manager added");
    setInvite({ link: r.inviteLink, emailStatus: r.emailStatus, email: r.member.email });
    setF({ name: "", email: "", phone: "" });
    router.refresh();
  });
  const closeAdd = () => { setAdding(false); setInvite(null); add.setError(null); };

  async function resend(m: TeamRow) {
    try {
      const r = await api<{ inviteLink: string; emailStatus: string }>(`/api/client/businesses/${businessId}/team/${m.id}`, { method: "POST" });
      setInvite({ link: r.inviteLink, emailStatus: r.emailStatus, email: m.email });
      setAdding(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the invitation");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">Managers can work with this business only. They cannot manage the team or account settings.</p>
        <Button size="sm" onClick={() => setAdding(true)}><UserPlus className="size-4" />Add manager</Button>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{m.name} {m.id === currentUserId && <span className="text-xs text-ink-muted">(you)</span>}</p>
              <p className="truncate text-xs text-ink-muted">{m.email} {m.lastLoginAt ? `- last sign-in ${formatDateTime(m.lastLoginAt)}` : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={m.role === "OWNER" ? "blue" : "gray"}>{m.role === "OWNER" ? "Owner" : "Manager"}</Badge>
              <StatusBadge status={m.status} />
              {m.role === "MANAGER" && m.status === "INVITED" && (
                <Button variant="ghost" size="sm" onClick={() => void resend(m)}><Mail className="size-4" />Resend invite</Button>
              )}
              {m.role === "MANAGER" && (
                <Button variant="ghost" size="sm" onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`}><Trash2 className="size-4" /></Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={adding} onClose={closeAdd} title={invite ? "Invitation link" : "Add a manager"} description={invite ? undefined : "They receive a link to set their own password."}>
        {invite ? (
          <div className="space-y-4">
            <InviteLinkBox link={invite.link} emailStatus={invite.emailStatus} purpose="INVITE" />
            <div className="flex justify-end"><Button onClick={closeAdd}>Done</Button></div>
          </div>
        ) : (
          <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
            {add.error && <Alert tone="error">{add.error}</Alert>}
            <Input label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={add.fieldErrors.name} />
            <Input label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={add.fieldErrors.email} />
            <Input label="Phone (optional)" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} error={add.fieldErrors.phone} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" type="button" onClick={closeAdd}>Cancel</Button>
              <Button type="submit" loading={add.pending}>Add manager</Button>
            </div>
          </form>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this manager?"
        description={removing ? `${removing.name} will lose access to this business immediately.` : ""}
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api(`/api/client/businesses/${businessId}/team/${removing.id}`, { method: "DELETE" });
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not remove this manager");
            throw e;
          }
          toast.success("Manager removed");
          router.refresh();
        }}
      />
    </div>
  );
}
