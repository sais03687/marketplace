-- AlterTable: add pauseReason column to Deployment
ALTER TABLE "Deployment" ADD COLUMN "pauseReason" TEXT;
