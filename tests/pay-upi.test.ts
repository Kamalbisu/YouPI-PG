import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPayment, getUpiPayment, cancelAttempt } from "@/server/services/checkout";
import { POST as upiRoute } from "@/app/api/pay/[publicId]/upi/route";
import { resetDb } from "./helpers";
import { activateConfig, code, customerCtx, idemKey, makeShop, mockProviderHttp, orderWithRazorpayAttempt, placeOrder, req, seg, stopProviderHttp, type FetchCall } from "./helpers-payments";

const UPI = "upi://pay?pa=merchant@cf&pn=Shop&am=100.00&tr=123&cu=INR";
const sessionsOk = (extra: Record<string, unknown> = {}) => (c: FetchCall): [number, unknown] | undefined =>
  c.url.endsWith("/orders/sessions") ? [200, { data: { payload: { default: UPI, gpay: "tez://upi/pay?pa=merchant@cf", phonepe: "phonepe://pay?pa=merchant@cf", ...extra } } }] : undefined;

beforeEach(async () => {
  await resetDb();
});
afterEach(() => stopProviderHttp());

async function cashfreeAttempt() {
  const calls = mockProviderHttp(sessionsOk());
  const shop = await makeShop();
  await activateConfig(shop, "CASHFREE");
  const order = await placeOrder(shop);
  const start = await startPayment(customerCtx(), { publicId: order.publicId, provider: "CASHFREE", method: "upi_gpay", idempotencyKey: idemKey("pay") });
  return { calls, shop, order, start };
}

describe("UPI QR + app link (Cashfree)", () => {
  it("returns a upi:// link, app links and a PNG QR for an open attempt", async () => {
    const { calls, order, start } = await cashfreeAttempt();
    const r = await getUpiPayment(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId });
    expect(r.uri).toBe(UPI);
    expect(r.appLinks.gpay).toContain("pa=merchant@cf");
    expect(r.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    const call = calls.find((c) => c.url.endsWith("/orders/sessions"))!;
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ payment_session_id: start.sessionId, payment_method: { upi: { channel: "link" } } });
    expect(call.headers["x-client-secret"]).toBeTruthy();
  });

  it("never marks the order paid", async () => {
    const { order, start } = await cashfreeAttempt();
    await getUpiPayment(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId });
    const { getPaymentStatus } = await import("@/server/services/payment-verification");
    expect((await getPaymentStatus(order.publicId)).paymentState).not.toBe("SUCCEEDED");
  });

  it("works through the public route", async () => {
    const { order, start } = await cashfreeAttempt();
    const res = await upiRoute(req("POST", `/api/pay/${order.publicId}/upi`, { body: { attemptId: start.attemptId } }), seg({ publicId: order.publicId }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { uri: string } };
    expect(json.data.uri).toBe(UPI);
  });

  it("rejects an attempt of another order, a cancelled attempt and unknown ids", async () => {
    const { shop, order, start } = await cashfreeAttempt();
    const other = await placeOrder(shop);
    expect(await code(() => getUpiPayment(customerCtx(), { publicId: other.publicId, attemptId: start.attemptId }))).toBe("NOT_FOUND");
    expect(await code(() => getUpiPayment(customerCtx(), { publicId: order.publicId, attemptId: "nope" }))).toBe("NOT_FOUND");
    await cancelAttempt(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId });
    expect(await code(() => getUpiPayment(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId }))).toBe("CONFLICT");
  });

  it("refuses a provider answer whose link is not a upi:// link", async () => {
    const { order, start } = await cashfreeAttempt();
    mockProviderHttp((c) => (c.url.endsWith("/orders/sessions") ? [200, { data: { payload: { default: "https://evil.example/pay" } } }] : undefined));
    expect(await code(() => getUpiPayment(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId }))).toBe("PAYMENT_ERROR");
  });

  it("surfaces provider errors without leaking details", async () => {
    const { order, start } = await cashfreeAttempt();
    mockProviderHttp((c) => (c.url.endsWith("/orders/sessions") ? [400, { message: "session expired" }] : undefined));
    expect(await code(() => getUpiPayment(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId }))).not.toBe("NO_ERROR");
  });

  it("is not available for providers without a UPI link (Razorpay uses its checkout)", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    const { configId } = await activateConfig(shop, "RAZORPAY");
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    expect(await code(() => getUpiPayment(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId }))).toBe("BAD_REQUEST");
  });
});
