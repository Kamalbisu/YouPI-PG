"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Select, useToast, ConfirmDialog } from "@/components/ui";
import { api } from "@/components/shared/use-api";

/** Admin: change status and priority. */
export function AdminTicketControls({ ticketId, status, priority }: { ticketId: string; status: string; priority: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const update = async (patch: { status?: string; priority?: string }) => {
    setBusy(true);
    try {
      await api(`/api/admin/support/${ticketId}`, { method: "PATCH", body: patch });
      toast.success("Ticket updated");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the ticket");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Select label="Status" value={status} disabled={busy} onChange={(e) => void update({ status: e.target.value })}>
          <option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option>
        </Select>
      <Select label="Priority" value={priority} disabled={busy} onChange={(e) => void update({ priority: e.target.value })}>
          <option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option>
        </Select>
    </div>
  );
}

/** Client: close own ticket. */
export function CloseTicketButton({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>Close ticket</Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Close this ticket?"
        description="You will not be able to reply after it is closed. You can open a new ticket any time."
        confirmLabel="Close ticket"
        onConfirm={async () => {
          try {
            await api(`/api/client/support/${ticketId}`, { method: "DELETE" });
            toast.success("Ticket closed");
            router.refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not close the ticket");
            throw e;
          }
        }}
      />
    </>
  );
}
