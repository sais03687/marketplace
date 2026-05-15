-- AlterTable: add commentCount to KnowledgeContribution
ALTER TABLE "KnowledgeContribution" ADD COLUMN "commentCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: ContributionComment
CREATE TABLE "ContributionComment" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContributionComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContributionComment_contributionId_idx" ON "ContributionComment"("contributionId");

-- AddForeignKey
ALTER TABLE "ContributionComment" ADD CONSTRAINT "ContributionComment_contributionId_fkey"
    FOREIGN KEY ("contributionId") REFERENCES "KnowledgeContribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionComment" ADD CONSTRAINT "ContributionComment_deploymentId_fkey"
    FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
