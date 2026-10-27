"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Alert, Button, Input } from "@/components/ui";
import { api, useAction } from "@/components/shared/use-api";

type Mode = "password" | "otp" | "signup";
const TABS: { key: Mode; label: string }[] = [
  { key: "password", label: "Password" },
  { key: "otp", label: "Email OTP" },
  { key: "signup", label: "Sign up" },
];

/** A code field plus resend countdown, shared by OTP login and signup. */
function CodeStep({ email, wait, onVerify, onResend, onBack, pending, error }: {
  email: string; wait: number; onVerify: (code: string) => void; onResend: () => void; onBack: () => void; pending: boolean; error: string | null;
}) {
  const [code, setCode] = useState("");
  const [left, setLeft] = useState(wait);
  // Restart the countdown whenever a new code is sent.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setLeft(wait), [wait]);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onVerify(code); }} className="space-y-4">
      <Alert tone="info">We emailed a 6-digit code to {email}. It is valid for 5 minutes.</Alert>
      {error && <Alert tone="error">{error}</Alert>}
      <Input label="Verification code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus required />
      <Button type="submit" className="w-full" loading={pending} disabled={code.length !== 6}>Verify</Button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={onBack} className="text-ink-muted hover:underline">Change email</button>
        <button type="button" onClick={() => { setCode(""); onResend(); }} disabled={left > 0} className="text-brand-600 hover:underline disabled:text-ink-muted disabled:no-underline">
          {left > 0 ? `Resend in ${left}s` : "Resend code"}
        </button>
      </div>
    </form>
  );
}

export function UserAuthForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [mode, setMode] = useState<Mode>("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [step, setStep] = useState<"form" | "code">("form");
  const [wait, setWait] = useState(45);

  const done = () => { router.replace("/dashboard"); router.refresh(); };
  const switchMode = (m: Mode) => { setMode(m); setStep("form"); };

  const login = useAction(async () => { await api("/api/auth/login", { method: "POST", body: { username, password } }); done(); });
  const otpSend = useAction(async () => {
    const r = await api<{ resendInSec: number }>("/api/auth/otp/request", { method: "POST", body: { email } });
    setWait(r.resendInSec); setStep("code");
  });
  const otpVerify = useAction(async (code: string) => { await api("/api/auth/otp/verify", { method: "POST", body: { email, code } }); done(); });
  const signupSend = useAction(async () => {
    const r = await api<{ resendInSec: number }>("/api/auth/signup", { method: "POST", body: { name, username, email, password } });
    setWait(r.resendInSec); setStep("code");
  });
  const signupVerify = useAction(async (code: string) => { await api("/api/auth/signup/verify", { method: "POST", body: { email, code } }); done(); });

  const submit = (fn: () => Promise<unknown>) => (e: React.FormEvent) => { e.preventDefault(); void fn(); };

  return (
    <div>
      <div className="mb-5 grid grid-cols-3 gap-1 rounded-lg bg-surface-muted p-1" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={mode === t.key} onClick={() => switchMode(t.key)}
            className={cn("rounded-md px-2 py-1.5 text-sm font-medium", mode === t.key ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink")}>
            {t.label}
          </button>
        ))}
      </div>
      {sp.get("error") === "forbidden" && <div className="mb-4"><Alert tone="warn">Please sign in with a user account.</Alert></div>}

      {mode === "password" && (
        <form onSubmit={submit(login.run)} className="space-y-4">
          {login.error && <Alert tone="error">{login.error}</Alert>}
          <Input label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Button type="submit" className="w-full" loading={login.pending}>Sign in</Button>
        </form>
      )}

      {mode === "otp" && (step === "form" ? (
        <form onSubmit={submit(otpSend.run)} className="space-y-4">
          {otpSend.error && <Alert tone="error">{otpSend.error}</Alert>}
          <Input label="Email" type="email" inputMode="email" autoComplete="email" hint="We will email you a code. New here? An account is created after you verify." value={email} onChange={(e) => setEmail(e.target.value)} error={otpSend.fieldErrors.email} required autoFocus />
          <Button type="submit" className="w-full" loading={otpSend.pending}>Send code</Button>
        </form>
      ) : (
        <CodeStep email={email} wait={wait} pending={otpVerify.pending} error={otpVerify.error} onVerify={(c) => void otpVerify.run(c)} onResend={() => void otpSend.run()} onBack={() => setStep("form")} />
      ))}

      {mode === "signup" && (step === "form" ? (
        <form onSubmit={submit(signupSend.run)} className="space-y-4">
          {signupSend.error && <Alert tone="error">{signupSend.error}</Alert>}
          <Input label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={signupSend.fieldErrors.name} required autoFocus />
          <Input label="Username" autoComplete="username" hint="3-30 letters, numbers or underscore" value={username} onChange={(e) => setUsername(e.target.value)} error={signupSend.fieldErrors.username} required />
          <Input label="Email" type="email" inputMode="email" autoComplete="email" hint="We will email you a code." value={email} onChange={(e) => setEmail(e.target.value)} error={signupSend.fieldErrors.email} required />
          <Input label="Password" type="password" autoComplete="new-password" hint="At least 10 characters with upper case, lower case and a number" value={password} onChange={(e) => setPassword(e.target.value)} error={signupSend.fieldErrors.password} required />
          <Button type="submit" className="w-full" loading={signupSend.pending}>Send code</Button>
        </form>
      ) : (
        <CodeStep email={email} wait={wait} pending={signupVerify.pending} error={signupVerify.error} onVerify={(c) => void signupVerify.run(c)} onResend={() => void signupSend.run()} onBack={() => setStep("form")} />
      ))}
    </div>
  );
}
