-- Pause accounting: record when a deployment was paused, not merely that it is.
--
-- `Deployment.pausedAt` is nulled on resume, so the history was destroyed. Both
-- the buyer's discount and the creator's payout sampled a single instant and
-- applied it to a whole month, at two different instants, so the two sides could
-- disagree about the same month in either direction.

ALTER TABLE "Deployment" ADD COLUMN "pauseCreditedThrough" TIMESTAMP(3);

CREATE TABLE "PausePeriod" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "PausePeriod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PausePeriod_deploymentId_startedAt_idx" ON "PausePeriod"("deploymentId", "startedAt");
CREATE INDEX "PausePeriod_deploymentId_endedAt_idx" ON "PausePeriod"("deploymentId", "endedAt");

ALTER TABLE "PausePeriod" ADD CONSTRAINT "PausePeriod_deploymentId_fkey"
    FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Anything already paused gets an open interval starting when it was paused, so
-- a pause that spans this deploy is still credited rather than beginning its
-- history at zero.
INSERT INTO "PausePeriod" ("id", "deploymentId", "startedAt", "endedAt", "reason")
SELECT
    md5(random()::text || clock_timestamp()::text || "id"),
    "id",
    "pausedAt",
    NULL,
    "pauseReason"
FROM "Deployment"
WHERE "status" = 'PAUSED' AND "pausedAt" IS NOT NULL;
