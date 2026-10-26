import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { ForgotForm } from "@/components/auth/token-forms";

export const metadata: Metadata = { title: "Forgot password" };

export default async function Page({ searchParams }: { searchParams: Promise<{ portal?: string }> }) {
  const { portal } = await searchParams;
  return (
    <AuthCard title="Forgot your password?" subtitle="Enter your email and we will send you a reset link.">
      <ForgotForm portal={portal === "admin" ? "admin" : "client"} />
    </AuthCard>
  );
}
