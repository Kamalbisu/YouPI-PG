"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Textarea, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

/** Reply form for both portals; `portal` picks the API prefix. */
export function ReplyBox({ ticketId, portal }: { ticketId: string; portal: "admin" | "client" }) {
  const router = useRouter();
  const toast = useToast();
  const [body, setBody] = useState("");
  const send = useAction(async () => {
    await api(`/api/${portal}/support/${ticketId}/reply`, { method: "POST", body: { body } });
    setBody("");
    toast.success("Reply sent");
    router.refresh();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void send.run(); }} className="space-y-3">
      {send.error && !Object.keys(send.fieldErrors ?? {}).length && <Alert tone="error">{send.error}</Alert>}
      <Textarea label="Reply" error={send.fieldErrors?.body} rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
      <div className="flex justify-end"><Button type="submit" loading={send.pending} disabled={body.trim().length < 3}>Send reply</Button></div>
    </form>
  );
}
