import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { AuditorLoginForm } from "@/components/auth/auditor-login-form";

export const metadata: Metadata = { title: "Admin 2 sign in" };

export default function AuditorLogin() {
  return (
    <AuthCard title="Admin 2 sign in" subtitle="Read-only view of all payment activity" footer={<Link href="/" className="hover:underline">Back to start</Link>}>
      <AuditorLoginForm />
    </AuthCard>
  );
}
