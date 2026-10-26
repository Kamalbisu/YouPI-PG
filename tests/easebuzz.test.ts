import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { amountString, computeResponseHash, generateInitiateHash, generateRefundHash, initiatePayment, mapGatewayState, paiseFromAmountString, parseRetrieveResponse, requestRefund, retrieveTransaction, sanitizeGatewayPayload, verifyResponseHash } from "@/server/gateway/easebuzz";
import { AppError } from "@/lib/errors";
import { vi } from "vitest";
import { CFG, clearGateway, configureGateway, gatewayPayload, mockFetch } from "./gateway-helpers";

beforeEach(() => configureGateway());
afterEach(() => {
  vi.unstubAllGlobals();
  clearGateway();
});

// Expected values below were computed independently with sha512 over the documented strings.
describe("hashes (known vectors)", () => {
  it("request hash = sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf10|salt)", () => {
    const base = { txnid: "txn1001", amount: "250.00", productinfo: "Fees", firstname: "Asha", email: "asha@example.com" };
    expect(generateInitiateHash(base, CFG)).toBe("d3fbdd71d0b61f93eabf811a69dbcc43213850641e29357c3e9e1059fce6e403eb8eba5d3e3bc995ac343d2cfa7dc91820881b3f41ec453fba2b2482c0f201a2");
    expect(generateInitiateHash({ ...base, udf1: "pay_1" }, CFG)).toBe("6bc05cc2552be3f53ff00d7dd757a3c8a999065ef02136fe3c8430c7cf0f0ed3b279337ae0d8b55b599cd03e3b1401815c240ca0ec49a8e3daac19ac6d309fa8");
  });

  it("response hash is the reverse order, starting with the salt and status", () => {
    const r = { status: "success", txnid: "txn1001", amount: "250.00", productinfo: "Fees", firstname: "Asha", email: "asha@example.com" };
    expect(computeResponseHash(r, CFG)).toBe("280316fac1be2a702e86935b33c27c759a5a7113778857968c75958d0e69e0afb00d8c35b11c8110e6e8153b3f6bef31a0b747b956b65330a7a54bd6a6e59ec7");
    expect(verifyResponseHash({ ...r, hash: computeResponseHash(r, CFG) }, CFG)).toBe(true);
  });

  it("refund hash = sha512(key|merchant_refund_id|easebuzz_id|refund_amount|salt)", () => {
    expect(generateRefundHash("YPR1", "EZ123", "50.00", CFG)).toBe("1c849e2d580d7ae9916d1a00a62c04582c7b70e76199fbf496bbe5b1b890cb19572fb7cea543ade3c76b725cce1d343a15a1611fb0d485f5e85ecb26ec398e8a");
  });
});

describe("verifyResponseHash", () => {
  it("rejects a tampered amount, status, or hash", () => {
    const good = gatewayPayload({ txnid: "t1", amount: "10.00" });
    expect(verifyResponseHash(good)).toBe(true);
    expect(verifyResponseHash({ ...good, amount: "1.00" })).toBe(false);
    expect(verifyResponseHash({ ...good, status: "failure" })).toBe(false);
    expect(verifyResponseHash({ ...good, hash: "0".repeat(128) })).toBe(false);
    expect(verifyResponseHash({ ...good, hash: "short" })).toBe(false);
    expect(verifyResponseHash({ ...good, hash: "" })).toBe(false);
  });
  it("accepts an upper-case hash", () => {
    const good = gatewayPayload({ txnid: "t1", amount: "10.00" });
    expect(verifyResponseHash({ ...good, hash: good.hash!.toUpperCase() })).toBe(true);
  });
  it("never throws on input that is not an object", () => {
    for (const bad of [null, undefined, "x", 42, true, [], ["hash"], () => 1]) expect(verifyResponseHash(bad)).toBe(false);
    expect(verifyResponseHash({ hash: 5 })).toBe(false);
  });
  it("returns false when the response was signed with a different salt", () => {
    const other = { ...CFG, salt: "OTHERSALT" };
    const r = gatewayPayload({ txnid: "t1", amount: "10.00" });
    r.hash = computeResponseHash(r, other);
    expect(verifyResponseHash(r)).toBe(false);
  });
});

describe("amounts", () => {
  it("formats paise with two decimals", () => {
    expect(amountString(25000)).toBe("250.00");
    expect(amountString(5)).toBe("0.05");
  });
  it("reads gateway amounts strictly", () => {
    expect(paiseFromAmountString("250")).toBe(25000);
    expect(paiseFromAmountString("250.5")).toBe(25050);
    expect(paiseFromAmountString("250.50")).toBe(25050);
    expect(paiseFromAmountString(250)).toBe(25000);
    for (const bad of ["", "abc", "1.234", "-5", "1e3", " ", null, undefined, {}]) expect(paiseFromAmountString(bad)).toBeNull();
  });
});

describe("sanitizeGatewayPayload", () => {
  it("removes the hash, key, salt, tokens and card numbers but keeps useful fields", () => {
    const out = sanitizeGatewayPayload({ txnid: "t1", amount: "1.00", hash: "abc", key: "k", salt: "s", card_no: "1", token: "t", mode: "UPI", status: "success" })!;
    expect(out).toMatchObject({ txnid: "t1", amount: "1.00", mode: "UPI", status: "success" });
    const text = JSON.stringify(out);
    for (const secret of ['"abc"', '"k"', '"s"', '"t"']) expect(text).not.toContain(secret);
    expect(sanitizeGatewayPayload("nope")).toBeNull();
    expect(sanitizeGatewayPayload(null)).toBeNull();
  });
});

describe("states", () => {
  it("maps gateway words", () => {
    expect(mapGatewayState("success")).toBe("success");
    expect(mapGatewayState("userCancelled")).toBe("failed");
    expect(mapGatewayState("failure")).toBe("failed");
    expect(mapGatewayState("pending")).toBe("pending");
    expect(mapGatewayState("???")).toBeNull();
    expect(mapGatewayState(undefined)).toBeNull();
  });
  it("reads a retrieve response in the shapes Easebuzz uses and refuses anything else", () => {
    expect(parseRetrieveResponse({ status: true, msg: { txnid: "t1", status: "success", amount: "5.00", easepayid: "E1" } })).toMatchObject({ txnid: "t1", state: "success", easebuzzId: "E1" });
    expect(parseRetrieveResponse({ data: [{ txnid: "t1", status: "failure" }] })?.state).toBe("failed");
    expect(parseRetrieveResponse({ status: false, msg: "Transaction not found" })).toBeNull();
    expect(parseRetrieveResponse(null)).toBeNull();
    expect(parseRetrieveResponse("x")).toBeNull();
    expect(parseRetrieveResponse({ msg: { txnid: "t1", status: "weird" } })).toBeNull();
  });
});

describe("HTTP calls (mocked)", () => {
  it("initiate posts to the sandbox host and builds the checkout URL", async () => {
    const calls = mockFetch([{ status: 1, data: "ACCESSKEY123" }]);
    const r = await initiatePayment({ txnid: "t1", amount: "10.00", productinfo: "Fees", firstname: "Asha", email: "a@example.com", phone: "9876543210", surl: "https://x/cb", furl: "https://x/cb" }, CFG);
    expect(r.checkoutUrl).toBe("https://testpay.easebuzz.in/pay/ACCESSKEY123");
    expect(calls[0]!.url).toBe("https://testpay.easebuzz.in/payment/initiateLink");
    expect(calls[0]!.body.get("key")).toBe("TESTKEY");
    expect(calls[0]!.body.get("hash")).toHaveLength(128);
    expect(calls[0]!.body.get("salt")).toBeNull();
  });
  it("uses the live hosts when EASEBUZZ_ENV=prod", async () => {
    configureGateway({ EASEBUZZ_ENV: "prod" });
    const calls = mockFetch([{ status: 1, data: "K" }]);
    const { gatewayConfig } = await import("@/server/gateway/easebuzz");
    const cfg = gatewayConfig()!;
    expect(cfg.env).toBe("prod");
    const r = await initiatePayment({ txnid: "t1", amount: "10.00", productinfo: "F", firstname: "A", email: "a@example.com", phone: "9876543210", surl: "u", furl: "u" });
    expect(r.checkoutUrl).toBe("https://pay.easebuzz.in/pay/K");
    expect(calls[0]!.url).toBe("https://pay.easebuzz.in/payment/initiateLink");
  });
  it("refuses to run when key and salt are missing", async () => {
    clearGateway();
    mockFetch([{}]);
    await expect(initiatePayment({ txnid: "t", amount: "1.00", productinfo: "F", firstname: "A", email: "a@e.com", phone: "9876543210", surl: "u", furl: "u" })).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });
  });
  it("turns a rejected initiate, a network error and a non-JSON answer into clear errors without leaking secrets", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = { txnid: "t1", amount: "10.00", productinfo: "F", firstname: "A", email: "a@e.com", phone: "9876543210", surl: "u", furl: "u" };
    mockFetch([{ status: 0, data: "Invalid hash" }]);
    await expect(initiatePayment(p, CFG)).rejects.toThrow(/did not accept/);
    mockFetch([new Error("boom TESTSALT")]);
    await expect(initiatePayment(p, CFG)).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });
    mockFetch(["<html>Bad gateway</html>"]);
    await expect(initiatePayment(p, CFG)).rejects.toThrow(/not JSON/);
    const logged = JSON.stringify(err.mock.calls);
    for (const secret of ["TESTSALT", "TESTKEY"]) expect(logged).not.toContain(secret);
    err.mockRestore();
  });
  it("retrieve signs key|txnid|salt and parses the answer", async () => {
    const calls = mockFetch([{ status: true, msg: { txnid: "txn1001", status: "success", amount: "250.00" } }]);
    const t = await retrieveTransaction("txn1001", CFG);
    expect(t?.state).toBe("success");
    expect(calls[0]!.url).toBe("https://testdashboard.easebuzz.in/transaction/v1/retrieve");
    expect(calls[0]!.body.get("hash")).toBe("ee4a2d555be502546d59ee8592615c6c7b36bd1a335507d58ab9ba9268a1e5d5b1af4eb6be6f10d536c4cff7637f4a883604277228dcaa7a00699bcdcbb625dc");
  });
  it("refund posts the signed request and reads the answer; non-JSON gives a clear error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = mockFetch([{ status: true, refund_id: "R9", reason: "ok" }]);
    const r = await requestRefund({ easebuzzId: "EZ123", amountPaise: 5000, merchantRefundId: "YPR1" }, CFG);
    expect(r).toMatchObject({ accepted: true, gatewayRefundId: "R9" });
    expect(calls[0]!.url).toBe("https://testdashboard.easebuzz.in/transaction/v2/refund");
    expect(calls[0]!.body.get("hash")).toBe("1c849e2d580d7ae9916d1a00a62c04582c7b70e76199fbf496bbe5b1b890cb19572fb7cea543ade3c76b725cce1d343a15a1611fb0d485f5e85ecb26ec398e8a");
    expect(calls[0]!.body.get("refund_amount")).toBe("50.00");
    mockFetch([{ status: false, reason: "Insufficient balance" }]);
    expect(await requestRefund({ easebuzzId: "EZ123", amountPaise: 5000, merchantRefundId: "YPR2" }, CFG)).toMatchObject({ accepted: false, message: "Insufficient balance" });
    mockFetch(["<html>oops</html>"]);
    const e = await requestRefund({ easebuzzId: "EZ123", amountPaise: 5000, merchantRefundId: "YPR3" }, CFG).catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).message).toMatch(/not JSON/);
    err.mockRestore();
  });
});
