-- AlterTable
ALTER TABLE "LPT_english"."User" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "planExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LPT_english"."PaymentOrder" (
    "id" TEXT NOT NULL,
    "outTradeNo" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "alipayTradeNo" TEXT,
    "paidAt" TIMESTAMP(3),
    "rawNotify" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LPT_english"."UsageLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_outTradeNo_key" ON "LPT_english"."PaymentOrder"("outTradeNo");

-- CreateIndex
CREATE INDEX "PaymentOrder_userId_status_idx" ON "LPT_english"."PaymentOrder"("userId", "status");

-- CreateIndex
CREATE INDEX "PaymentOrder_createdAt_idx" ON "LPT_english"."PaymentOrder"("createdAt");

-- CreateIndex
CREATE INDEX "UsageLog_userId_kind_createdAt_idx" ON "LPT_english"."UsageLog"("userId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "LPT_english"."PaymentOrder" ADD CONSTRAINT "PaymentOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."UsageLog" ADD CONSTRAINT "UsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

