import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function ClientLogin() {
  return (
    <AuthCard title="Sign in" subtitle="Manage your businesses, QR codes and payments" footer={<>Platform admin? <Link className="text-brand-600 hover:underline" href="/admin/login">Admin sign in</Link></>}>
      <Suspense><LoginForm portal="client" /></Suspense>
    </AuthCard>
  );
}
