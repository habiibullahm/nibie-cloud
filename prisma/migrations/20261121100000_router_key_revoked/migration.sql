-- The instance's NibieRouter key was revoked after the customer replaced it with their own (additive, nullable).
ALTER TABLE "RouterProvisioning" ADD COLUMN "keyRevokedAt" TIMESTAMPTZ(3);
