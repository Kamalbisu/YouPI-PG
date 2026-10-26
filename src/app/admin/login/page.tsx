import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Admin sign in" };

export default function AdminLogin() {
  return (
    <AuthCard title="Admin sign in" subtitle="Platform administration">
      <Suspense><LoginForm portal="admin" /></Suspense>
    </AuthCard>
  );
}
