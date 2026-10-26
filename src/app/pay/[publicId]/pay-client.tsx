"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, Download, QrCode, Smartphone, XCircle } from "lucide-react";
import { Button, Card, CardBody } from "@/components/ui";
import { formatMinor } from "@/lib/money";
import type { PublicOrderView } from "@/server/services/orders";
import type { PaymentOptions, StartPaymentResult, UpiPaymentResult } from "@/server/services/checkout";
import type { PaymentStatusView } from "@/server/services/payment-verification";

type Api<T> = { data: T } | { error: { code: string; message: string } };

async function call<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init ? { "Content-Type": "application/json" } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  let json: Api<T> | null = null;
  try {
    json = (await res.json()) as Api<T>;
  } catch {
    /* handled below */
  }
  if (!json || "error" in json) throw new Error(json && "error" in json ? json.error.message : "Something went wrong. Please try again.");
  return json.data;
}

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open(): void; on(ev: string, cb: (r: unknown) => void): void };
    Cashfree?: (cfg: { mode: "sandbox" | "production" }) => { checkout(o: Record<string, unknown>): Promise<{ error?: { message?: string }; paymentDetails?: unknown }> };
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment window. Check your connection and try again."));
    document.head.appendChild(s);
  });
}

const APP_NAMES: Record<string, string> = { gpay: "Google Pay", phonepe: "PhonePe", paytm: "Paytm", bhim: "BHIM", cred: "CRED" };
const isUpi = (m: string) => m.startsWith("upi_");
const TERMINAL_BAD = new Set(["FAILED", "CANCELLED", "EXPIRED"]);

export function PayClient({ order, options }: { order: PublicOrderView; options: PaymentOptions }) {
  const [status, setStatus] = useState<PaymentStatusView | null>(null);
  const [attempt, setAttempt] = useState<StartPaymentResult | null>(null);
  const [upi, setUpi] = useState<UpiPaymentResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const paid = status?.paymentState === "SUCCEEDED" || order.status === "PAID";
  const failedState = status && TERMINAL_BAD.has(status.paymentState) ? status.paymentState : null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await call<PaymentStatusView>(`/api/pay/${order.publicId}/status`);
      if (alive.current) setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, [order.publicId]);

  // Poll the server-verified state while a payment is in progress. Only the server decides "paid".
  useEffect(() => {
    if (!attempt || paid) return;
    const t = setInterval(() => void refresh(), 3000);
    void refresh();
    return () => clearInterval(t);
  }, [attempt, paid, refresh]);

  const reset = useCallback(
    async (cancel: boolean) => {
      if (cancel && attempt) await call(`/api/pay/${order.publicId}/cancel`, { method: "POST", body: { attemptId: attempt.attemptId } }).catch(() => undefined);
      setAttempt(null);
      setUpi(null);
      setStatus((s) => (s?.paymentState === "SUCCEEDED" ? s : null));
      setError(null);
    },
    [attempt, order.publicId],
  );

  async function openProviderCheckout(a: StartPaymentResult) {
    if (a.checkoutKind === "razorpay_checkout") {
      await loadScript("https://checkout.razorpay.com/v1/checkout.js");
      if (!window.Razorpay || !a.publicKeyId) throw new Error("Could not open the payment window.");
      const rzp = new window.Razorpay({
        key: a.publicKeyId,
        order_id: a.providerOrderId,
        amount: a.amountMinor,
        currency: a.currency,
        name: a.businessName,
        description: `Order ${a.orderCode}`,
        prefill: { name: a.customer.name ?? undefined, contact: a.customer.phone ?? undefined, email: a.customer.email ?? undefined },
        theme: { color: "#4f46e5" },
        handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          try {
            await call(`/api/pay/${order.publicId}/verify`, {
              method: "POST",
              body: { providerOrderId: r.razorpay_order_id, providerPaymentId: r.razorpay_payment_id, signature: r.razorpay_signature },
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : "We could not confirm the payment yet.");
          }
          void refresh();
        },
        modal: { ondismiss: () => void refresh() },
      });
      rzp.on("payment.failed", () => void refresh());
      rzp.open();
      return;
    }
    if (a.checkoutKind === "cashfree_session") {
      await loadScript("https://sdk.cashfree.com/js/v3/cashfree.js");
      if (!window.Cashfree || !a.sessionId) throw new Error("Could not open the payment window.");
      const cf = window.Cashfree({ mode: a.mode === "LIVE" ? "production" : "sandbox" });
      const r = await cf.checkout({ paymentSessionId: a.sessionId, redirectTarget: "_modal" });
      if (r?.error?.message) setError(r.error.message);
      // Cashfree gives no signed browser result: the server asks the provider for the real state.
      void refresh();
    }
  }

  async function choose(provider: string, method: string) {
    const key = `${provider}:${method}`;
    setBusy(key);
    setError(null);
    try {
      const a = await call<StartPaymentResult>(`/api/pay/${order.publicId}/start`, {
        method: "POST",
        body: { provider, method, idempotencyKey: `web-${crypto.randomUUID()}` },
      });
      setAttempt(a);
      if (a.checkoutKind === "cashfree_session" && isUpi(a.method)) {
        setUpi(await call<UpiPaymentResult>(`/api/pay/${order.publicId}/upi`, { method: "POST", body: { attemptId: a.attemptId } }));
      } else if (a.checkoutKind !== "simulator") {
        await openProviderCheckout(a);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the payment.");
    } finally {
      setBusy(null);
    }
  }

  async function simulate(outcome: "success" | "failure" | "cancel") {
    if (!attempt) return;
    setBusy("sim");
    try {
      await call(`/api/pay/${order.publicId}/simulate`, { method: "POST", body: { attemptId: attempt.attemptId, outcome } });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed.");
    } finally {
      setBusy(null);
    }
  }

  const header = (
    <div className="text-center">
      <p className="text-sm text-ink-muted">{order.businessName}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-ink">{formatMinor(order.totalMinor, order.currency)}</p>
      <p className="mt-1 text-xs text-ink-muted">Order {order.orderCode}</p>
    </div>
  );

  const summary = (
    <Card>
      <CardBody className="space-y-1.5 text-sm">
        {order.items.map((it, i) => (
          <div key={i} className="flex justify-between gap-3">
            <span className="text-ink">
              {it.name} <span className="text-ink-muted">× {it.quantity}</span>
            </span>
            <span className="tabular-nums text-ink">{formatMinor(it.lineTotalMinor, order.currency)}</span>
          </div>
        ))}
        {order.discountMinor > 0 && (
          <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
            <span>Discount{order.couponCode ? ` (${order.couponCode})` : ""}</span>
            <span className="tabular-nums">-{formatMinor(order.discountMinor, order.currency)}</span>
          </div>
        )}
        {order.taxMinor > 0 && (
          <div className="flex justify-between text-ink-muted">
            <span>Tax</span>
            <span className="tabular-nums">{formatMinor(order.taxMinor, order.currency)}</span>
          </div>
        )}
        <div className="flex justify-between border-t border-line pt-2 font-semibold text-ink">
          <span>Total</span>
          <span className="tabular-nums">{formatMinor(order.totalMinor, order.currency)}</span>
        </div>
      </CardBody>
    </Card>
  );

  if (paid) {
    return (
      <>
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 className="size-14 text-emerald-600" aria-hidden />
            <h1 className="text-xl font-semibold text-ink">Payment received</h1>
            <p className="text-sm text-ink-muted">
              {formatMinor(order.totalMinor, order.currency)} paid to {order.businessName}.
              {status?.txnRef ? ` Reference ${status.txnRef}.` : ""}
            </p>
            <a
              href={`/api/pay/${order.publicId}/receipt/pdf`}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              <Download className="size-4" aria-hidden /> Download receipt
            </a>
          </CardBody>
        </Card>
        {summary}
      </>
    );
  }

  if (!options.payable) {
    return (
      <>
        {header}
        <Card>
          <CardBody className="flex flex-col items-center gap-2 py-8 text-center">
            <Clock className="size-10 text-ink-muted" aria-hidden />
            <p className="font-medium text-ink">This order can&apos;t be paid right now</p>
            <p className="text-sm text-ink-muted">{options.reason ?? "Please ask the business for a new payment link."}</p>
          </CardBody>
        </Card>
        {summary}
      </>
    );
  }

  return (
    <>
      {header}
      {failedState && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {failedState === "EXPIRED" ? "This payment expired." : failedState === "CANCELLED" ? "The payment was cancelled." : "The payment did not go through."}
            {status?.failureReason ? ` ${status.failureReason}` : ""} If money was debited, it is refunded automatically by your bank.
          </span>
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {upi && attempt ? (
        <UpiPanel upi={upi} attempt={attempt} total={formatMinor(order.totalMinor, order.currency)} onBack={() => void reset(true)} />
      ) : attempt?.checkoutKind === "simulator" ? (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm font-medium text-ink">Test payment (development only)</p>
            <Button className="w-full" loading={busy === "sim"} onClick={() => void simulate("success")}>
              Simulate success
            </Button>
            <Button variant="outline" className="w-full" disabled={busy === "sim"} onClick={() => void simulate("failure")}>
              Simulate failure
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => void reset(true)}>
              Choose another method
            </Button>
          </CardBody>
        </Card>
      ) : attempt ? (
        <Card>
          <CardBody className="space-y-3 text-center">
            <p className="text-sm text-ink-muted">Complete the payment in the payment window. This page updates by itself once the payment is confirmed.</p>
            <Button variant="outline" className="w-full" onClick={() => void openProviderCheckout(attempt).catch((e: Error) => setError(e.message))}>
              Reopen payment window
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => void reset(true)}>
              Choose another method
            </Button>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm font-medium text-ink">Choose how to pay</p>
            {options.options.length === 0 && <p className="text-sm text-ink-muted">No payment method is set up for this business yet.</p>}
            {options.options.map((o) => (
              <Button
                key={`${o.provider}:${o.method}`}
                variant={isUpi(o.method) ? "primary" : "outline"}
                size="lg"
                className="w-full justify-start"
                loading={busy === `${o.provider}:${o.method}`}
                disabled={busy !== null}
                onClick={() => void choose(o.provider, o.method)}
              >
                {isUpi(o.method) ? <QrCode className="size-5" aria-hidden /> : null}
                {o.label}
              </Button>
            ))}
          </CardBody>
        </Card>
      )}
      {summary}
      <p className="text-center text-xs text-ink-muted">Payments are confirmed securely by the payment provider. Never share your UPI PIN.</p>
    </>
  );
}

function UpiPanel({ upi, attempt, total, onBack }: { upi: UpiPaymentResult; attempt: StartPaymentResult; total: string; onBack: () => void }) {
  const preferred = attempt.upiApp && attempt.upiApp !== "other" ? upi.appLinks[attempt.upiApp] : undefined;
  const apps = Object.entries(upi.appLinks) as [string, string][];
  return (
    <Card>
      <CardBody className="space-y-4 text-center">
        <div>
          <p className="text-sm font-medium text-ink">Scan to pay {total}</p>
          <p className="text-xs text-ink-muted">Open any UPI app, tap Scan, and scan this code.</p>
        </div>
        <img src={upi.qrDataUrl} alt={`UPI QR code to pay ${total}`} width={240} height={240} className="mx-auto rounded-lg border border-line bg-white p-2" />
        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>
        <a
          href={preferred ?? upi.uri}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-6 text-base font-medium text-white shadow-sm hover:bg-brand-700"
        >
          <Smartphone className="size-5" aria-hidden /> Pay with UPI app
        </a>
        {apps.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {apps.map(([k, href]) => (
              <a key={k} href={href} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-muted">
                {APP_NAMES[k] ?? k}
              </a>
            ))}
          </div>
        )}
        <p className="text-xs text-ink-muted">Waiting for payment… this page updates automatically once your bank confirms.</p>
        <Button variant="ghost" className="w-full" onClick={onBack}>
          Choose another method
        </Button>
      </CardBody>
    </Card>
  );
}
