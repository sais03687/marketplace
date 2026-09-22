-- One row per (agent, version). Publishing a version again replaces it.
--
-- The publish wizard created a row per upload, so correcting a package and
-- publishing again left two rows with the same version number, both PENDING and
-- indistinguishable in the admin queue. Since each upload now stores its own
-- package, approving the wrong one would ship the code the creator replaced.
-- The route no longer does this; the constraint makes it structural.
--
-- Existing duplicates are collapsed to the most recent row first, or the index
-- cannot be created. On 2026-09-21 there was exactly one such pair, both
-- PENDING and both pointing at the same stored package, so nothing reviewed and
-- nothing distinct is lost. The id comparison is a tiebreaker for rows written
-- in the same clock tick.
DELETE FROM "AgentVersion" a
USING "AgentVersion" b
WHERE a."agentId" = b."agentId"
  AND a."version" = b."version"
  AND (a."createdAt" < b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

CREATE UNIQUE INDEX "AgentVersion_agentId_version_key"
  ON "AgentVersion"("agentId", "version");
