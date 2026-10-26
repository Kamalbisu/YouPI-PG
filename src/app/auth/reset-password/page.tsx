import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { SetPasswordForm } from "@/components/auth/token-forms";
import { checkToken } from "@/server/services/auth";

export const metadata: Metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const t = token ? await checkToken(token, "PASSWORD_RESET") : null;
  if (!token || !t) {
    return (
      <AuthCard title="Link expired" subtitle="This link is invalid, already used, or has expired.">
        <Link href="/auth/forgot-password" className="text-sm text-brand-600 hover:underline">Request a new link</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Reset your password" subtitle="Choose a strong password you do not use anywhere else.">
      <SetPasswordForm token={token} portal={t.user.role === "SUPER_ADMIN" ? "admin" : "client"} invite={false} />
    </AuthCard>
  );
}
