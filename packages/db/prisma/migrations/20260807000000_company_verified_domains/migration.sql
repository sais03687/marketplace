-- Company.domain was being used as an email allowlist despite never being
-- validated against anything. requireOrg() defaults it to the literal
-- "company.com" — a real registered domain — so every auto-created company
-- authorised its agent to start conversations with strangers there.
--
-- verifiedDomains holds what Microsoft says the buyer's tenant actually owns.
-- Empty grants nothing, which is the safe direction: the agent's own mail
-- domain already covers its colleagues.
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "verifiedDomains" JSONB NOT NULL DEFAULT '[]';
