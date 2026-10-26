import Link from "next/link";
import { ThemeToggle } from "@/components/layout/theme-toggle";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-page p-6 text-center">
      <div className="absolute top-4 right-4"><ThemeToggle /></div>
      <div className="flex items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">Y</div>
        <h1 className="text-3xl font-semibold">YouPI PG</h1>
      </div>
      <p className="max-w-md text-ink-muted">Pay online or with your QR code, and see when each payment is confirmed.</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/login" className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700">Sign in or sign up</Link>
        <Link href="/admin/login" className="rounded-lg border border-line px-5 py-2.5 text-sm font-medium hover:bg-surface-muted">Admin sign in</Link>
        <Link href="/auditor/login" className="rounded-lg border border-line px-5 py-2.5 text-sm font-medium hover:bg-surface-muted">Admin 2 sign in</Link>
      </div>
    </main>
  );
}
