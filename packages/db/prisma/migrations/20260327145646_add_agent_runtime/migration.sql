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
