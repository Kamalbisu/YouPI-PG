"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, CardBody, CardHeader, Input, useToast } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export function AuditorForm() {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState({ name: "", email: "", username: "", password: "" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  const act = useAction(async () => {
    await api("/api/admin/auditors", { method: "POST", body: v });
    toast.success("Admin 2 account created");
    setV({ name: "", email: "", username: "", password: "" });
    router.refresh();
  });
  return (
    <Card>
      <CardHeader title="Add an Admin 2" description="Admin 2 can see every payment activity but cannot change anything." />
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); void act.run(); }} className="space-y-4">
          {act.error && <Alert tone="error">{act.error}</Alert>}
          <Input label="Name" value={v.name} onChange={set("name")} error={act.fieldErrors.name} required />
          <Input label="Email" type="email" value={v.email} onChange={set("email")} error={act.fieldErrors.email} required />
          <Input label="Username" value={v.username} onChange={set("username")} error={act.fieldErrors.username} required />
          <Input label="Password" type="password" autoComplete="new-password" value={v.password} onChange={set("password")} error={act.fieldErrors.password} required />
          <Button type="submit" loading={act.pending}>Create</Button>
        </form>
      </CardBody>
    </Card>
  );
}
