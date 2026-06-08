-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN "workspaceScope" TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE "Deployment" ADD COLUMN "buyerMicrosoftTenantId" TEXT;
