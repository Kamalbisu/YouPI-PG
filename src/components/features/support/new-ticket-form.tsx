"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, CardBody, Input, Select, Textarea, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export function NewTicketForm({ businesses }: { businesses: { id: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState({ subject: "", body: "", priority: "NORMAL", businessId: "" });
  const submit = useAction(async () => {
    const t = await api<{ id: string }>("/api/client/support", { method: "POST", body: v });
    toast.success("Ticket created");
    router.push(`/client/support/${t.id}`);
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Card>
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); void submit.run(); }} className="space-y-4">
          {submit.error && !Object.keys(submit.fieldErrors ?? {}).length && <Alert tone="error">{submit.error}</Alert>}
          <Input label="Subject" error={submit.fieldErrors?.subject} value={v.subject} onChange={set("subject")} maxLength={150} required />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Priority" error={submit.fieldErrors?.priority} value={v.priority} onChange={set("priority")}>
                <option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option>
              </Select>
            <Select label="Related business (optional)" error={submit.fieldErrors?.businessId} value={v.businessId} onChange={set("businessId")}>
                <option value="">None</option>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
          </div>
          <Textarea label="Message" error={submit.fieldErrors?.body} rows={6} value={v.body} onChange={set("body")} maxLength={5000} required />
          <div className="flex justify-end"><Button type="submit" loading={submit.pending}>Submit ticket</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}
