import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { UserAuthForm } from "@/components/auth/user-auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <AuthCard title="Welcome" subtitle="Sign in or create an account" footer={<a href="/admin/login" className="hover:underline">Admin sign in</a>}>
      <Suspense><UserAuthForm /></Suspense>
    </AuthCard>
  );
}
