-- Creator access is now gated (request -> admin approve/deny).
CREATE TYPE "CreatorStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

ALTER TABLE "Creator"
  ADD COLUMN "status" "CreatorStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "requestNote" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- Every creator that already exists is operating today; do not lock them out.
-- They are approved by definition. Only NEW requests start life as PENDING.
UPDATE "Creator" SET "status" = 'APPROVED', "reviewedAt" = now();
