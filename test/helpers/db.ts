import type { PrismaClient } from '@prisma/client';

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "InstanceEvent", "Instance", "TenantMember", "User", "RuntimeNode", "Plan", "Tenant" RESTART IDENTITY CASCADE',
  );
}
