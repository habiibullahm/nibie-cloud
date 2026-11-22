CREATE TABLE "RetiredRuntime" (
  "nodeId" UUID NOT NULL,
  "instanceId" UUID NOT NULL,
  "storageMb" INTEGER NOT NULL CHECK ("storageMb" > 0),
  CONSTRAINT "RetiredRuntime_pkey" PRIMARY KEY ("nodeId", "instanceId"),
  CONSTRAINT "RetiredRuntime_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "RuntimeNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RetiredRuntime_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "RetiredRuntime_instanceId_idx" ON "RetiredRuntime"("instanceId");
ALTER TABLE "RetiredRuntime" ENABLE ROW LEVEL SECURITY;
