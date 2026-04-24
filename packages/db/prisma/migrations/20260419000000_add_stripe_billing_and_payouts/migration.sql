-- Add IT_SUPPORT to AgentCategory enum
ALTER TYPE "AgentCategory" ADD VALUE IF NOT EXISTS 'IT_SUPPORT';

-- Add Stripe fields to Creator
ALTER TABLE "Creator"
  ADD COLUMN IF NOT EXISTS "stripeAccountId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeOnboarded" BOOLEAN NOT NULL DEFAULT false;

-- Add Stripe customer ID to Company
ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;

-- Add Stripe subscription ID to Deployment
ALTER TABLE "Deployment"
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;

-- Add service account fields and portalToken to Deployment
ALTER TABLE "Deployment"
  ADD COLUMN IF NOT EXISTS "deploymentServiceAccountEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "deploymentServiceAccountKey" TEXT,
  ADD COLUMN IF NOT EXISTS "deploymentServiceAccountSetup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "portalToken" TEXT DEFAULT gen_random_uuid()::text;

-- Make portalToken unique (only after backfilling)
ALTER TABLE "Deployment"
  ADD CONSTRAINT IF NOT EXISTS "Deployment_portalToken_key" UNIQUE ("portalToken");

-- Add fields to Agent
ALTER TABLE "Agent"
  ADD COLUMN IF NOT EXISTS "memoryTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "onboardingQuestions" JSONB;

-- Add fields to AgentVersion
ALTER TABLE "AgentVersion"
  ADD COLUMN IF NOT EXISTS "manifestData" JSONB,
  ADD COLUMN IF NOT EXISTS "storagePath" TEXT;

-- Create PayoutStatus enum
DO $$ BEGIN
  CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create Payout table
CREATE TABLE IF NOT EXISTS "Payout" (
  "id"                TEXT NOT NULL DEFAULT cuid(),
  "creatorId"         TEXT NOT NULL,
  "periodStart"       TIMESTAMP(3) NOT NULL,
  "periodEnd"         TIMESTAMP(3) NOT NULL,
  "grossRevenueCents" INTEGER NOT NULL,
  "platformFeeCents"  INTEGER NOT NULL,
  "creatorShareCents" INTEGER NOT NULL,
  "status"            "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "stripeTransferId"  TEXT,
  "failureReason"     TEXT,
  "paidAt"            TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- Add indexes on Payout
CREATE INDEX IF NOT EXISTS "Payout_creatorId_periodStart_idx" ON "Payout"("creatorId", "periodStart");
CREATE INDEX IF NOT EXISTS "Payout_status_idx" ON "Payout"("status");

-- Add foreign key from Payout to Creator
DO $$ BEGIN
  ALTER TABLE "Payout"
    ADD CONSTRAINT "Payout_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
