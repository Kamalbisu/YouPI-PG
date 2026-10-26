import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AdminLoginForm } from "@/components/auth/admin-login-form";

export const metadata: Metadata = { title: "Admin sign in" };

export default function AdminLogin() {
  return (
    <AuthCard title="Admin sign in" subtitle="Manage users, QR codes and payments" footer={<a href="/login" className="hover:underline">Looking for the user sign in?</a>}>
      <Suspense><AdminLoginForm /></Suspense>
    </AuthCard>
  );
}
