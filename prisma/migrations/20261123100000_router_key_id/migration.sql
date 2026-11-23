-- Router id of the last instance key we created (additive, nullable): lets a retry replace our own key whose secret was lost.
ALTER TABLE "RouterProvisioning" ADD COLUMN "routerKeyId" TEXT;
