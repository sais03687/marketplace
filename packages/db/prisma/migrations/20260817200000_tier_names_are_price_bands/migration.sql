-- Tier names said whose models they were, not what they cost.
--
-- HAIKU / SONNET / OPUS are one vendor's model line, and the catalogue has
-- always held Google and OpenAI models too: a creator picking Gemini 2.5 Pro
-- declared SONNET, and the buyer saw a competitor's product name on the
-- listing. The tier has only ever meant a price band -- $29, $59, $149 -- so it
-- is now named after that.
--
-- RENAME VALUE rather than a new type: it preserves every row in place, needs
-- no backfill, and cannot leave a row holding a value the type no longer has.
-- The old names survive in application code as accepted aliases, because they
-- are written into every manifest published before today.
ALTER TYPE "ModelTier" RENAME VALUE 'HAIKU' TO 'STANDARD';
ALTER TYPE "ModelTier" RENAME VALUE 'SONNET' TO 'PRO';
ALTER TYPE "ModelTier" RENAME VALUE 'OPUS' TO 'PREMIUM';
