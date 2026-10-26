"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { api } from "@/components/shared/use-api";

export function UserStatusButton({ id, status, name }: { id: string; status: "ACTIVE" | "DISABLED"; name: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const disabling = status === "ACTIVE";
  return (
    <>
      <Button variant={disabling ? "danger" : "primary"} size="sm" onClick={() => setOpen(true)}>{disabling ? "Disable user" : "Enable user"}</Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        danger={disabling}
        title={disabling ? "Disable this user?" : "Enable this user?"}
        description={disabling ? `${name} will be signed out and will not be able to sign in until you enable them again.` : `${name} will be able to sign in again.`}
        confirmLabel={disabling ? "Disable" : "Enable"}
        onConfirm={async () => {
          try {
            await api(`/api/admin/users/${id}`, { method: "PATCH", body: { status: disabling ? "DISABLED" : "ACTIVE" } });
            toast.success(disabling ? "User disabled" : "User enabled");
            router.refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not update the user");
            throw e;
          }
        }}
      />
    </>
  );
}
