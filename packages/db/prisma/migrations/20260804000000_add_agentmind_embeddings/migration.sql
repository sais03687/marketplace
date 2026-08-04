-- Semantic search vectors for AgentMind contributions.
--
-- Float[] rather than pgvector: the extension is available on this database, but
-- a vector column requires Unsupported(...) in Prisma and raw SQL for every query
-- touching the model. At this corpus size a full scan with cosine similarity in
-- application code is free. Revisit with an HNSW index if this grows.
ALTER TABLE "KnowledgeContribution"
  ADD COLUMN "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
  ADD COLUMN "embeddedAt" TIMESTAMP(3);
