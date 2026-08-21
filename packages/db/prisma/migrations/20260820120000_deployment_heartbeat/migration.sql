-- Liveness signal. The agent posts a heartbeat on a short timer; the dashboard
-- shows it and a periodic check alerts on staleness, turning a silent failure
-- into a visible one. All nullable and additive.
ALTER TABLE "Deployment" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
ALTER TABLE "Deployment" ADD COLUMN "lastHeartbeatOk" BOOLEAN;
ALTER TABLE "Deployment" ADD COLUMN "heartbeatAlertedAt" TIMESTAMP(3);
