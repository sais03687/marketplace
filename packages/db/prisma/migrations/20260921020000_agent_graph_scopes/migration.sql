-- What an agent declared it reaches in the buyer's Microsoft 365, so the listing
-- can show it before anyone pays. Null means the agent declared nothing, which
-- is every agent published before this column existed; an empty array means it
-- declared it needs nothing. The listing distinguishes the two.
ALTER TABLE "Agent" ADD COLUMN "graphScopes" JSONB;
