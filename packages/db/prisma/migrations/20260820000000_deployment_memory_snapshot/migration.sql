-- A read-only snapshot of the agent's memory, pushed up by the agent so the
-- dashboard can display it without the web app reaching the container (which it
-- cannot; the container is behind a firewall and Vercel is outside it). Mirrors
-- how approvals already reach the dashboard: the agent writes to the platform.
-- Nullable and additive, so it applies without touching any existing row.
ALTER TABLE "Deployment" ADD COLUMN "memorySnapshot" JSONB;
ALTER TABLE "Deployment" ADD COLUMN "memorySyncedAt" TIMESTAMP(3);
