-- Which of the same buyer's other hires each agent works with: a JSON array of
-- deployment ids, kept symmetric by the API. Empty for every existing hire, so
-- no agent starts accepting another's mail until the buyer chooses it.
ALTER TABLE "Deployment" ADD COLUMN "worksWith" JSONB NOT NULL DEFAULT '[]';
