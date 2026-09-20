-- A bounced email left no trace the buyer could see. The platform logged "Sent"
-- the moment Graph accepted the message; the delivery failure arrived later, in
-- the agent's own mailbox, and was dropped as not-a-task. Record it instead.
ALTER TABLE "Deployment"
  ADD COLUMN "lastDeliveryFailureAt" TIMESTAMP(3),
  ADD COLUMN "lastDeliveryFailureTo" TEXT,
  ADD COLUMN "lastDeliveryFailureReason" TEXT;
