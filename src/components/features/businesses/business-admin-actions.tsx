"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Pause, Play, X } from "lucide-react";
import { Button, useToast } from "@/components/ui";
import { api } from "@/components/shared/use-api";
import { ReasonDialog } from "@/components/features/clients/reason-dialog";

type Kind = "approve" | "reject" | "suspend" | "reactivate";

/** Lifecycle buttons for the admin business page; which ones show depends on the current status. */
export function BusinessAdminActions({ businessId, status }: { businessId: string; status: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Kind | null>(null);
  const run = async (kind: Kind, reason?: string, msg?: string) => {
    await api(`/api/admin/businesses/${businessId}/${kind}`, { method: "POST", body: reason ? { reason } : {} });
    toast.success(msg ?? "Done");
    router.refresh();
  };
  return (
    <>
      {(status === "PENDING_APPROVAL" || status === "REJECTED") && (
        <Button onClick={() => setOpen("approve")}><Check className="size-4" />Approve</Button>
      )}
      {status === "PENDING_APPROVAL" && <Button variant="danger" onClick={() => setOpen("reject")}><X className="size-4" />Reject</Button>}
      {status === "ACTIVE" && <Button variant="danger" onClick={() => setOpen("suspend")}><Pause className="size-4" />Suspend</Button>}
      {(status === "SUSPENDED" || status === "INACTIVE") && <Button onClick={() => setOpen("reactivate")}><Play className="size-4" />Reactivate</Button>}

      <ReasonDialog open={open === "approve"} onClose={() => setOpen(null)} title="Approve this business?" description="The business becomes active and its team is notified." confirmLabel="Approve" required={false}
        onSubmit={async () => run("approve", undefined, "Business approved")} />
      <ReasonDialog open={open === "reject"} onClose={() => setOpen(null)} title="Reject this business?" description="The client sees the reason you give here." confirmLabel="Reject" danger
        onSubmit={(r) => run("reject", r, "Business rejected")} />
      <ReasonDialog open={open === "suspend"} onClose={() => setOpen(null)} title="Suspend this business?" description="Payments and QR codes stop working until it is reactivated. The client sees the reason." confirmLabel="Suspend" danger
        onSubmit={(r) => run("suspend", r, "Business suspended")} />
      <ReasonDialog open={open === "reactivate"} onClose={() => setOpen(null)} title="Reactivate this business?" description="The business becomes active again." confirmLabel="Reactivate" required={false}
        onSubmit={async () => run("reactivate", undefined, "Business reactivated")} />
    </>
  );
}
