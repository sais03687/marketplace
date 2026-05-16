-- CreateEnum
CREATE TYPE "AgentCategory" AS ENUM ('SALES_OPERATIONS', 'CUSTOMER_SUCCESS', 'EXECUTIVE_ASSISTANT', 'RESEARCH', 'MARKETING_OPS', 'HR_OPS', 'FINANCE_OPS', 'ENGINEERING_OPS', 'GENERAL');

-- CreateEnum
CREATE TYPE "AgentRuntime" AS ENUM ('OPENCLAW', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'LIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "VetStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'MANUALLY_APPROVED');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PROVISIONING', 'ONBOARDING', 'ACTIVE', 'PAUSED', 'FIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "OnboardingState" AS ENUM ('INTERVIEW', 'OBSERVATION', 'INTRODUCTION', 'LIVE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'EDITED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ModelTier" AS ENUM ('HAIKU', 'SONNET', 'OPUS');

-- CreateEnum
CREATE TYPE "CompanyPlan" AS ENUM ('PAY_PER_AGENT', 'TEAM', 'ENTERPRISE');

-- CreateTable
CREATE TABLE "Creator" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "stripeAccountId" TEXT,
    "stripeOnboarded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Creator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "AgentCategory" NOT NULL,
    "pricePerMonth" INTEGER NOT NULL,
    "modelTier" "ModelTier" NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'DRAFT',
    "runtime" "AgentRuntime" NOT NULL DEFAULT 'OPENCLAW',
    "currentVersion" TEXT,
    "packageUrl" TEXT,
    "averageRating" DOUBLE PRECISION,
    "totalDeployments" INTEGER NOT NULL DEFAULT 0,
    "avgApprovalRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentVersion" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "packageUrl" TEXT NOT NULL,
    "changelog" TEXT,
    "testResults" JSONB,
    "vetStatus" "VetStatus" NOT NULL DEFAULT 'PENDING',
    "vetNotes" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Capability" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "clerkOrgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "plan" "CompanyPlan" NOT NULL DEFAULT 'PAY_PER_AGENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PROVISIONING',
    "agentName" TEXT NOT NULL,
    "agentEmail" TEXT,
    "agentEmailApiKey" TEXT,
    "slackBotToken" TEXT,
    "slackAppToken" TEXT,
    "slackAppId" TEXT,
    "containerName" TEXT,
    "stripeSubscriptionId" TEXT,
    "autonomyConfig" JSONB NOT NULL,
    "onboardingState" "OnboardingState" NOT NULL DEFAULT 'INTERVIEW',
    "onboardingData" JSONB,
    "approvalWebhookToken" TEXT NOT NULL,
    "weeklyDigestEmail" TEXT,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "firedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "draft" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "originalRequest" TEXT NOT NULL,
    "stakesScore" DOUBLE PRECISION NOT NULL,
    "ambiguityScore" DOUBLE PRECISION NOT NULL,
    "reversibilityScore" DOUBLE PRECISION NOT NULL,
    "combinedScore" DOUBLE PRECISION NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedBy" TEXT,
    "resolutionAction" TEXT,
    "editDiff" TEXT,
    "rejectionReason" TEXT,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustScore" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "approvedNoEdit" INTEGER NOT NULL DEFAULT 0,
    "edited" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "weightedScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "autonomyLevel" TEXT NOT NULL DEFAULT 'always_queue',
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "verifiedHire" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningLog" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "errorStack" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvisioningLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Creator_clerkUserId_key" ON "Creator"("clerkUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Creator_email_key" ON "Creator"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_slug_key" ON "Agent"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Company_clerkOrgId_key" ON "Company"("clerkOrgId");

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- CreateIndex
CREATE INDEX "Deployment_companyId_idx" ON "Deployment"("companyId");

-- CreateIndex
CREATE INDEX "Approval_status_idx" ON "Approval"("status");

-- CreateIndex
CREATE INDEX "Approval_deploymentId_idx" ON "Approval"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustScore_deploymentId_taskType_key" ON "TrustScore"("deploymentId", "taskType");

-- CreateIndex
CREATE INDEX "ProvisioningLog_deploymentId_idx" ON "ProvisioningLog"("deploymentId");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentVersion" ADD CONSTRAINT "AgentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustScore" ADD CONSTRAINT "TrustScore_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- CreateEnum
CREATE TYPE "ContributionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContributionType" AS ENUM ('CORRECTION', 'PATTERN', 'RESPONSE_TEMPLATE', 'TASK_RECIPE');

-- CreateTable
CREATE TABLE "KnowledgeContribution" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "type" "ContributionType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "rawContent" TEXT NOT NULL,
    "context" TEXT,
    "tags" TEXT[],
    "status" "ContributionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "downvotes" INTEGER NOT NULL DEFAULT 0,
    "sanitizationLog" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeVote" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "vote" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeContribution_agentId_status_idx" ON "KnowledgeContribution"("agentId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeContribution_status_idx" ON "KnowledgeContribution"("status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVote_contributionId_deploymentId_key" ON "KnowledgeVote"("contributionId", "deploymentId");

-- AddForeignKey
ALTER TABLE "KnowledgeContribution" ADD CONSTRAINT "KnowledgeContribution_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeContribution" ADD CONSTRAINT "KnowledgeContribution_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVote" ADD CONSTRAINT "KnowledgeVote_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "KnowledgeContribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVote" ADD CONSTRAINT "KnowledgeVote_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "agentEmailInboxId" TEXT;
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
