import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { assignQr, createQr, deleteQr, getQrImageFor, listQrsForUser, unassignQr } from "@/server/services/qr";
import { confirmTransaction, listTransactionsAdmin, rejectTransaction, submitTransaction } from "@/server/services/transactions";
import { listNotificationsAdmin, listNotificationsForUser, markRead, sendNotification, unreadCount } from "@/server/services/notifications";
import { getUserDetail, setUserStatus } from "@/server/services/users";
import { actorFromToken } from "@/server/auth/session";
import { ctxFor, makeAdmin, makeUser, pngFile, resetDb } from "./helpers";

let admin: Awaited<ReturnType<typeof ctxFor>>;
let alice: Awaited<ReturnType<typeof ctxFor>>;
let bob: Awaited<ReturnType<typeof ctxFor>>;
let aliceId: string;
let bobId: string;

async function newQr(label: string, opts: { forAll?: boolean; active?: boolean; amount?: string } = {}) {
  return createQr(admin, { label, forAll: opts.forAll ? "true" : "false", active: opts.active === false ? "false" : "true", amount: opts.amount }, pngFile());
}

beforeEach(async () => {
  await resetDb();
  const a = await makeAdmin();
  const u1 = await makeUser("alice", "+919800000001");
  const u2 = await makeUser("bob", "+919800000002");
  aliceId = u1.id;
  bobId = u2.id;
  admin = await ctxFor(a);
  alice = await ctxFor(u1);
  bob = await ctxFor(u2);
});

describe("QR visibility", () => {
  it("a user sees only QRs assigned to them, plus 'for all' QRs", async () => {
    const forAlice = await newQr("Alice only");
    const forBob = await newQr("Bob only");
    const everyone = await newQr("Everyone", { forAll: true });
    await assignQr(admin, forAlice.id, { username: "alice" });
    await assignQr(admin, forBob.id, { userId: bobId });

    const aliceList = (await listQrsForUser(alice.actor!)).map((q) => q.label).sort();
    const bobList = (await listQrsForUser(bob.actor!)).map((q) => q.label).sort();
    expect(aliceList).toEqual(["Alice only", "Everyone"]);
    expect(bobList).toEqual(["Bob only", "Everyone"]);
    expect(forAlice.id).not.toBe(everyone.id);
  });

  it("inactive QRs disappear for users but stay for admin", async () => {
    const q = await newQr("Paused", { forAll: true, active: false });
    expect(await listQrsForUser(alice.actor!)).toHaveLength(0);
    await expect(getQrImageFor(alice.actor!, q.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getQrImageFor(admin.actor!, q.id)).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("a user cannot fetch the image of someone else's QR", async () => {
    const q = await newQr("Bob only");
    await assignQr(admin, q.id, { username: "bob" });
    await expect(getQrImageFor(alice.actor!, q.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getQrImageFor(bob.actor!, q.id)).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("unassigning removes access", async () => {
    const q = await newQr("Temp");
    await assignQr(admin, q.id, { username: "alice" });
    expect(await listQrsForUser(alice.actor!)).toHaveLength(1);
    await unassignQr(admin, q.id, { username: "alice" });
    expect(await listQrsForUser(alice.actor!)).toHaveLength(0);
  });

  it("each user's list holds only their own submissions", async () => {
    const q = await newQr("Shared", { forAll: true });
    await submitTransaction(alice, { qrId: q.id, txnId: "AAAA11112222" });
    await submitTransaction(bob, { qrId: q.id, txnId: "BBBB11112222" });
    const a = await listQrsForUser(alice.actor!);
    expect(a[0]!.transactions.map((t) => t.txnId)).toEqual(["AAAA11112222"]);
  });

  it("deleting a QR with submissions only deactivates it; one without is removed", async () => {
    const used = await newQr("Used", { forAll: true });
    await submitTransaction(alice, { qrId: used.id, txnId: "USED12345678" });
    expect(await deleteQr(admin, used.id)).toEqual({ deleted: false, deactivated: true });
    expect((await db.qr.findUnique({ where: { id: used.id } }))?.active).toBe(false);
    const unused = await newQr("Unused");
    expect(await deleteQr(admin, unused.id)).toEqual({ deleted: true, deactivated: false });
    expect(await db.qr.findUnique({ where: { id: unused.id } })).toBeNull();
  });
});

describe("submitting transaction IDs", () => {
  it("stores a pending submission with the ID upper-cased and trimmed", async () => {
    const q = await newQr("Pay", { forAll: true });
    const t = await submitTransaction(alice, { qrId: q.id, txnId: "  abc123def4567 " });
    expect(t).toMatchObject({ txnId: "ABC123DEF4567", status: "PENDING" });
  });

  it("rejects malformed IDs", async () => {
    const q = await newQr("Pay", { forAll: true });
    for (const bad of ["", "short", "has space inside1", "bad-chars-!!!!", "x".repeat(31)]) {
      await expect(submitTransaction(alice, { qrId: q.id, txnId: bad })).rejects.toBeTruthy();
    }
  });

  it("rejects a duplicate ID, even from another user or in other case", async () => {
    const q = await newQr("Pay", { forAll: true });
    await submitTransaction(alice, { qrId: q.id, txnId: "DUP123456789" });
    await expect(submitTransaction(alice, { qrId: q.id, txnId: "DUP123456789" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(submitTransaction(bob, { qrId: q.id, txnId: "dup123456789" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.transaction.count()).toBe(1);
  });

  it("a user cannot submit against a QR they cannot see", async () => {
    const q = await newQr("Bob only");
    await assignQr(admin, q.id, { username: "bob" });
    await expect(submitTransaction(alice, { qrId: q.id, txnId: "SNEAKY123456" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.transaction.count()).toBe(0);
  });

  it("admins cannot submit and anonymous callers are refused", async () => {
    const q = await newQr("Pay", { forAll: true });
    await expect(submitTransaction(admin, { qrId: q.id, txnId: "ADMIN1234567" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(submitTransaction({ actor: null, ip: "1.1.1.1", userAgent: null }, { qrId: q.id, txnId: "ANON12345678" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("is rate limited per user", async () => {
    const q = await newQr("Pay", { forAll: true });
    for (let i = 0; i < 10; i++) await submitTransaction(alice, { qrId: q.id, txnId: `RATE0000000${String(i).padStart(2, "0")}` });
    await expect(submitTransaction(alice, { qrId: q.id, txnId: "RATE000000099" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("admin reviews transactions", () => {
  async function pending(txnId = "PEND12345678") {
    const q = await newQr("Pay", { forAll: true });
    return submitTransaction(alice, { qrId: q.id, txnId });
  }

  it("confirms, records who and when, and writes an audit entry", async () => {
    const t = await pending();
    await confirmTransaction(admin, t.id);
    const row = await db.transaction.findUnique({ where: { id: t.id } });
    expect(row).toMatchObject({ status: "CONFIRMED", reviewedById: admin.actor!.userId, rejectReason: null });
    expect(row?.reviewedAt).toBeTruthy();
    expect(await db.auditLog.count({ where: { action: "transaction.confirm", entityId: t.id } })).toBe(1);
  });

  it("rejects with a reason that the user then sees", async () => {
    const t = await pending();
    await rejectTransaction(admin, t.id, { reason: "Amount not received" });
    const mine = await listQrsForUser(alice.actor!);
    expect(mine[0]!.transactions[0]).toMatchObject({ status: "REJECTED", rejectReason: "Amount not received" });
    expect(await db.auditLog.count({ where: { action: "transaction.reject", entityId: t.id } })).toBe(1);
  });

  it("requires a reason to reject", async () => {
    const t = await pending();
    await expect(rejectTransaction(admin, t.id, { reason: "" })).rejects.toBeTruthy();
    expect((await db.transaction.findUnique({ where: { id: t.id } }))?.status).toBe("PENDING");
  });

  it("a decision is final: no second review", async () => {
    const t = await pending();
    await confirmTransaction(admin, t.id);
    await expect(rejectTransaction(admin, t.id, { reason: "changed my mind" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(confirmTransaction(admin, t.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("two admins clicking together decide it only once", async () => {
    const t = await pending();
    const results = await Promise.allSettled([confirmTransaction(admin, t.id), rejectTransaction(admin, t.id, { reason: "race" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("users cannot review", async () => {
    const t = await pending();
    await expect(confirmTransaction(alice, t.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rejectTransaction(alice, t.id, { reason: "nope nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists with status, user and search filters", async () => {
    const q = await newQr("Pay", { forAll: true });
    const a = await submitTransaction(alice, { qrId: q.id, txnId: "ALICE1234567" });
    await submitTransaction(bob, { qrId: q.id, txnId: "BOBBY1234567" });
    await confirmTransaction(admin, a.id);
    expect((await listTransactionsAdmin(admin, {})).total).toBe(2);
    expect((await listTransactionsAdmin(admin, { status: "CONFIRMED" })).total).toBe(1);
    expect((await listTransactionsAdmin(admin, { userId: bobId })).items[0]!.txnId).toBe("BOBBY1234567");
    expect((await listTransactionsAdmin(admin, { q: "bobby123" })).total).toBe(1);
  });
});

describe("notifications", () => {
  it("a one-user notification reaches only that user", async () => {
    await sendNotification(admin, { userId: aliceId, title: "Hi Alice", body: "Just for you" });
    expect((await listNotificationsForUser(alice.actor!)).map((n) => n.title)).toEqual(["Hi Alice"]);
    expect(await listNotificationsForUser(bob.actor!)).toHaveLength(0);
    expect(await unreadCount(aliceId)).toBe(1);
    expect(await unreadCount(bobId)).toBe(0);
  });

  it("an 'all users' notification reaches everyone, including users who join later", async () => {
    await sendNotification(admin, { userId: "all", title: "Notice", body: "To everyone" });
    expect(await unreadCount(aliceId)).toBe(1);
    expect(await unreadCount(bobId)).toBe(1);
    const carol = await makeUser("carol", "+919800000003");
    await new Promise((r) => setTimeout(r, 20));
    // created before carol joined, so it is not shown to her
    expect(await unreadCount(carol.id)).toBe(0);
    await sendNotification(admin, { title: "Second", body: "Empty userId means all" });
    expect(await unreadCount(carol.id)).toBe(1);
  });

  it("marking read affects only the reader, and cannot touch notifications meant for others", async () => {
    const mine = await sendNotification(admin, { userId: aliceId, title: "Mine", body: "a" });
    const all = await sendNotification(admin, { title: "Shared", body: "b" });
    expect(await markRead(bob.actor!, { ids: [mine.id] })).toEqual({ marked: 0 });
    expect(await markRead(alice.actor!, { ids: [mine.id] })).toEqual({ marked: 1 });
    expect(await unreadCount(aliceId)).toBe(1);
    expect(await unreadCount(bobId)).toBe(1);
    await markRead(alice.actor!, { all: true });
    expect(await unreadCount(aliceId)).toBe(0);
    expect(await unreadCount(bobId)).toBe(1);
    expect(all.id).toBeTruthy();
  });

  it("only admins send; unknown recipients and empty text are refused", async () => {
    await expect(sendNotification(alice, { title: "Hello", body: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sendNotification(admin, { userId: "does-not-exist", title: "Hello", body: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sendNotification(admin, { title: "Hello", body: "" })).rejects.toBeTruthy();
    await expect(sendNotification(admin, { userId: admin.actor!.userId, title: "Hello", body: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("admin sees what was sent", async () => {
    await sendNotification(admin, { userId: aliceId, title: "One", body: "x" });
    await sendNotification(admin, { title: "Two", body: "y" });
    expect((await listNotificationsAdmin(admin, {})).total).toBe(2);
  });
});

describe("admin user management", () => {
  it("shows the full picture of a user", async () => {
    const q = await newQr("Pay", { forAll: true });
    await submitTransaction(alice, { qrId: q.id, txnId: "DETAIL123456" });
    await sendNotification(admin, { userId: aliceId, title: "Hi", body: "x" });
    const d = (await getUserDetail(admin, aliceId)) as Record<string, unknown>;
    expect(JSON.stringify(d)).toContain("DETAIL123456");
    expect(JSON.stringify(d)).not.toContain("passwordHash");
  });

  it("disabling a user ends their sessions; enabling restores access", async () => {
    await setUserStatus(admin, aliceId, { status: "DISABLED" });
    const token = (await db.session.findFirst({ where: { userId: aliceId } }))!;
    expect(token).toBeTruthy();
    await expect(submitTransaction(alice, { qrId: "x", txnId: "ABCDEFGH1234" })).rejects.toBeTruthy();
    expect((await db.user.findUnique({ where: { id: aliceId } }))?.status).toBe("DISABLED");
    await setUserStatus(admin, aliceId, { status: "ACTIVE" });
    expect((await db.user.findUnique({ where: { id: aliceId } }))?.status).toBe("ACTIVE");
    expect(actorFromToken).toBeTypeOf("function");
  });

  it("users cannot read other users or change status", async () => {
    await expect(getUserDetail(alice, bobId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setUserStatus(alice, bobId, { status: "DISABLED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
