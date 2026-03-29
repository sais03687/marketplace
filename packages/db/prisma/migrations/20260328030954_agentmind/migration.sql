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
