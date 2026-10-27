-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('EASEBUZZ', 'QR');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('QUEUED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActivityActorType" AS ENUM ('USER', 'ADMIN', 'AUDITOR', 'SYSTEM', 'GATEWAY');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'AUDITOR';

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "method" "PaymentMethod" NOT NULL DEFAULT 'EASEBUZZ',
    "easebuzzId" TEXT,
    "gatewayMode" TEXT,
    "failureReason" TEXT,
    "paidAmountPaise" INTEGER,
    "gatewayResponse" JSONB,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "merchantRefundId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "reason" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'QUEUED',
    "gatewayRefundId" TEXT,
    "failureReason" TEXT,
    "requestedById" TEXT,
    "gatewayResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "actorType" "ActivityActorType" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "targetUserId" TEXT,
    "paymentId" TEXT,
    "refundId" TEXT,
    "transactionId" TEXT,
    "paymentRef" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_txnId_key" ON "payments"("txnId");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_method_createdAt_idx" ON "payments"("method", "createdAt");

-- CreateIndex
CREATE INDEX "payments_easebuzzId_idx" ON "payments"("easebuzzId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_merchantRefundId_key" ON "refunds"("merchantRefundId");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE INDEX "refunds_status_createdAt_idx" ON "refunds"("status", "createdAt");

-- CreateIndex
CREATE INDEX "activity_events_createdAt_idx" ON "activity_events"("createdAt");

-- CreateIndex
CREATE INDEX "activity_events_targetUserId_createdAt_idx" ON "activity_events"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_events_paymentId_createdAt_idx" ON "activity_events"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_events_actorId_createdAt_idx" ON "activity_events"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_events_type_createdAt_idx" ON "activity_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "activity_events_paymentRef_idx" ON "activity_events"("paymentRef");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- activity_events is append-only: reject UPDATE and DELETE at the database level.
CREATE OR REPLACE FUNCTION activity_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only (% not allowed)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_events_no_update
  BEFORE UPDATE ON "activity_events"
  FOR EACH ROW EXECUTE FUNCTION activity_events_append_only();

CREATE TRIGGER activity_events_no_delete
  BEFORE DELETE ON "activity_events"
  FOR EACH ROW EXECUTE FUNCTION activity_events_append_only();
