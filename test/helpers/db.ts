import type { PrismaClient } from '@prisma/client';

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "PaymentEvent", "RouterProvisioning", "InstanceEvent", "Instance", "WaitlistEntry", "BetaInvite", "AdminApiKey", "SupportContact", "BillingSetting", "TenantMember", "User", "RuntimeNode", "Plan", "Tenant", "InvoiceCounter" RESTART IDENTITY CASCADE',
  );
}
