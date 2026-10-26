"use client";
import Link from "next/link";
import { useState } from "react";
import { Alert, Button, Input } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

export function ForgotForm({ portal }: { portal: "admin" | "client" }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const a = useAction(async () => {
    await api("/api/auth/forgot", { method: "POST", body: { email } });
    setSent(true);
  });
  if (sent)
    return (
      <div className="space-y-4">
        <Alert tone="success">If an account exists for that email, a reset link is on its way. The link is valid for one hour.</Alert>
        <Link href={`/${portal}/login`} className="block text-center text-sm text-brand-600 hover:underline">Back to sign in</Link>
      </div>
    );
  return (
    <form onSubmit={(e) => { e.preventDefault(); void a.run(); }} className="space-y-4" noValidate>
      {a.error && <Alert tone="error">{a.error}</Alert>}
      <Input label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} error={a.fieldErrors.email} />
      <Button type="submit" className="w-full" loading={a.pending}>Send reset link</Button>
      <Link href={`/${portal}/login`} className="block text-center text-sm text-brand-600 hover:underline">Back to sign in</Link>
    </form>
  );
}

export function SetPasswordForm({ token, portal, invite }: { token: string; portal: "admin" | "client"; invite: boolean }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const a = useAction(async () => {
    if (password !== confirm) { setMismatch("Passwords do not match"); return; }
    setMismatch(undefined);
    await api("/api/auth/set-password", { method: "POST", body: { token, password } });
    setDone(true);
  });
  if (done)
    return (
      <div className="space-y-4">
        <Alert tone="success">{invite ? "Your account is ready." : "Password updated."} Sign in to continue.</Alert>
        <Link href={`/${portal}/login`} className="block rounded-lg bg-brand-600 py-2 text-center text-sm font-medium text-white hover:bg-brand-700">Go to sign in</Link>
      </div>
    );
  return (
    <form onSubmit={(e) => { e.preventDefault(); void a.run(); }} className="space-y-4" noValidate>
      {a.error && <Alert tone="error">{a.error}</Alert>}
      <Input label="New password" type="password" autoComplete="new-password" required hint="At least 10 characters with upper case, lower case and a number." value={password} onChange={(e) => setPassword(e.target.value)} error={a.fieldErrors.password} />
      <Input label="Confirm password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch} />
      <Button type="submit" className="w-full" loading={a.pending}>{invite ? "Set password" : "Reset password"}</Button>
    </form>
  );
}
