-- Retire the OPENCLAW runtime.
--
-- The runtime itself is gone from the provisioning service: local-runner,
-- openclaw-config and the OpenClaw container path were deleted, so nothing can
-- provision an OPENCLAW agent any more.
--
-- One agent is still listed as OPENCLAW (general-ops-alex, 4 published versions,
-- 0 deployments). It is suspended rather than deleted: its package is built for a
-- runtime that no longer exists, so leaving it LIVE would let a buyer hire an
-- agent whose provisioning is guaranteed to fail. Suspending preserves the
-- listing and its version history while making it unhireable.

-- 1. Suspend anything that can no longer be provisioned.
UPDATE "Agent" SET "status" = 'SUSPENDED' WHERE "runtime" = 'OPENCLAW';

-- 2. Move those rows onto the only remaining runtime so the enum value is unused.
UPDATE "Agent" SET "runtime" = 'CUSTOM' WHERE "runtime" = 'OPENCLAW';

-- 3. Postgres cannot drop a value from an enum in place, so recreate the type.
--    The default must be dropped first: it references the old type.
ALTER TABLE "Agent" ALTER COLUMN "runtime" DROP DEFAULT;
ALTER TYPE "AgentRuntime" RENAME TO "AgentRuntime_old";
CREATE TYPE "AgentRuntime" AS ENUM ('CUSTOM');
ALTER TABLE "Agent"
  ALTER COLUMN "runtime" TYPE "AgentRuntime"
  USING ("runtime"::text::"AgentRuntime");
ALTER TABLE "Agent" ALTER COLUMN "runtime" SET DEFAULT 'CUSTOM';
DROP TYPE "AgentRuntime_old";
