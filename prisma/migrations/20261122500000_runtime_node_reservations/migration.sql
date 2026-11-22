ALTER TABLE "RuntimeNode" ADD COLUMN "agentManaged" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Instance" ADD COLUMN "recoveryNodeId" UUID;
ALTER TABLE "Subscription" ADD COLUMN "reservedNodeId" UUID;
ALTER TABLE "WaitlistEntry" ADD COLUMN "reservedNodeId" UUID;

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_reservedNodeId_fkey"
  FOREIGN KEY ("reservedNodeId") REFERENCES "RuntimeNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_reservedNodeId_fkey"
  FOREIGN KEY ("reservedNodeId") REFERENCES "RuntimeNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_recoveryNodeId_fkey"
  FOREIGN KEY ("recoveryNodeId") REFERENCES "RuntimeNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Instance_nodeId_status_idx" ON "Instance"("nodeId", "status");
CREATE INDEX "Instance_recoveryNodeId_idx" ON "Instance"("recoveryNodeId");
CREATE INDEX "Subscription_reservedNodeId_idx" ON "Subscription"("reservedNodeId");
CREATE INDEX "WaitlistEntry_reservedNodeId_idx" ON "WaitlistEntry"("reservedNodeId");
