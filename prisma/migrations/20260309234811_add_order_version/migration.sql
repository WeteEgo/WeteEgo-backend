-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'FORWARDED', 'ESCROWED', 'EXPIRED', 'SETTLED', 'REFUNDED', 'FAILED');

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "settlementRef" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "fiatAmount" DOUBLE PRECISION NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "paycrestRef" TEXT,
    "provider" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bankAccount" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_settlementRef_key" ON "Order"("settlementRef");

-- CreateIndex
CREATE INDEX "Order_walletAddress_idx" ON "Order"("walletAddress");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");
