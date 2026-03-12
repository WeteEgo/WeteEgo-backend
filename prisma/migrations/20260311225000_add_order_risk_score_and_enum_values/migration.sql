-- Add new OrderStatus enum values (PostgreSQL: ADD VALUE cannot run inside transaction in PG < 12, so we use separate statements)
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PAYOUT_SENT';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW';

-- Add riskScore column to Order
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "riskScore" INTEGER NOT NULL DEFAULT 0;
