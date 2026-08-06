-- Staleness and harm detection for AgentMind.
--
-- Context: seven near-duplicate "do not attempt X" lessons accumulated over two
-- days and taught the agent to refuse emailing its own manager. Nothing detected
-- the pile-up, nothing expired, and usageCount counted injections rather than
-- value — so the most harmful lesson also ranked highest.

-- Why a row was held for review: "cluster" or "unfounded".
ALTER TABLE "KnowledgeContribution" ADD COLUMN "flagReason" TEXT;

-- When to look at it again. Set from the contribution type on approval.
ALTER TABLE "KnowledgeContribution" ADD COLUMN "reviewDueAt" TIMESTAMP(3);

-- Outcome tracking. injectedCount is what usageCount always actually measured;
-- noActionCount is the new signal — how often the agent did nothing after being
-- given this lesson.
ALTER TABLE "KnowledgeContribution"
  ADD COLUMN "injectedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "noActionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastUsedAt" TIMESTAMP(3);

-- Existing rows have been injected at least usageCount times; seed so ratios are
-- not skewed by history being treated as zero.
UPDATE "KnowledgeContribution" SET "injectedCount" = "usageCount";

-- One deployment's decision to stop using one commons lesson.
CREATE TABLE "ContributionMute" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContributionMute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContributionMute_contributionId_deploymentId_key"
  ON "ContributionMute"("contributionId", "deploymentId");
CREATE INDEX "ContributionMute_deploymentId_idx" ON "ContributionMute"("deploymentId");

ALTER TABLE "ContributionMute" ADD CONSTRAINT "ContributionMute_contributionId_fkey"
  FOREIGN KEY ("contributionId") REFERENCES "KnowledgeContribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContributionMute" ADD CONSTRAINT "ContributionMute_deploymentId_fkey"
  FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
