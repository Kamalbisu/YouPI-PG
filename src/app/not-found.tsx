import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-5xl font-semibold text-brand-600">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-ink-muted">The page you are looking for does not exist or you do not have access to it.</p>
      <Link href="/" className="mt-2 text-sm text-brand-600 hover:underline">Go home</Link>
    </main>
  );
}
