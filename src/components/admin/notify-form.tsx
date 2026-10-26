"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, CardBody, CardHeader, Input, Select, Textarea } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export function NotifyForm({ users, fixedUserId }: { users?: { id: string; name: string; username: string }[]; fixedUserId?: string }) {
  const router = useRouter();
  const [to, setTo] = useState(fixedUserId ?? "all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ok, setOk] = useState(false);
  const send = useAction(async () => {
    await api("/api/admin/notifications", { method: "POST", body: { userId: to, title, body } });
    setTitle(""); setBody(""); setOk(true);
    router.refresh();
  });
  return (
    <Card>
      <CardHeader title="Send a notification" description="Users see it on their dashboard with an unread badge." />
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); setOk(false); void send.run(); }} className="space-y-4">
          {send.error && <Alert tone="error">{send.error}</Alert>}
          {ok && <Alert tone="success">Notification sent.</Alert>}
          {!fixedUserId && (
            <Select label="Send to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="all">All users</option>
              {users?.map((u) => <option key={u.id} value={u.id}>{u.name} (@{u.username})</option>)}
            </Select>
          )}
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} error={send.fieldErrors.title} required />
          <Textarea label="Message" rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} error={send.fieldErrors.body} required />
          <Button type="submit" loading={send.pending}>Send</Button>
        </form>
      </CardBody>
    </Card>
  );
}
