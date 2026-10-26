"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Button, Input } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export function AdminLoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const submit = useAction(async () => {
    await api("/api/admin/auth/login", { method: "POST", body: { login, password } });
    router.replace("/admin");
    router.refresh();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit.run(); }} className="space-y-4">
      {sp.get("error") === "forbidden" && <Alert tone="warn">This area is for admins only. Sign in with an admin account.</Alert>}
      {submit.error && <Alert tone="error">{submit.error}</Alert>}
      <Input label="Email or username" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus />
      <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <Button type="submit" className="w-full" loading={submit.pending}>Sign in</Button>
    </form>
  );
}
