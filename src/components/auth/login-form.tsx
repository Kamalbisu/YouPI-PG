"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Input } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export function LoginForm({ portal }: { portal: "admin" | "client" }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [needTotp, setNeedTotp] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", totp: "" });
  const action = useAction(async () => {
    try {
      const r = await api<{ redirectTo: string }>("/api/auth/login", {
        method: "POST",
        body: { portal, email: form.email, password: form.password, totp: form.totp || undefined },
      });
      router.push(r.redirectTo);
      router.refresh();
    } catch (e) {
      if (e instanceof Error && (e as { code?: string }).code === "TWO_FACTOR_REQUIRED") setNeedTotp(true);
      throw e;
    }
  });
  const reset = sp.get("reset") === "1";
  const forbidden = sp.get("error") === "forbidden";

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void action.run(); }}
      className="space-y-4"
      noValidate
    >
      {reset && <Alert tone="success">Password updated. Sign in with your new password.</Alert>}
      {forbidden && <Alert tone="error">That account cannot use this portal.</Alert>}
      {action.error && !needTotp && <Alert tone="error">{action.error}</Alert>}
      {needTotp && <Alert tone="info">Enter the 6-digit code from your authenticator app.</Alert>}
      <Input label="Email" type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={action.fieldErrors.email} />
      <Input label="Password" type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} error={action.fieldErrors.password} />
      {needTotp && (
        <Input label="Authentication code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={form.totp} onChange={(e) => setForm({ ...form, totp: e.target.value.replace(/\D/g, "") })} error={action.error ?? undefined} />
      )}
      <Button type="submit" className="w-full" loading={action.pending}>Sign in</Button>
      <p className="text-center text-sm">
        <Link href={`/auth/forgot-password?portal=${portal}`} className="text-brand-600 hover:underline">Forgot your password?</Link>
      </p>
    </form>
  );
}
