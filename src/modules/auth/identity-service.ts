import type { PrismaClient } from '@prisma/client';
import type { AuthClaims } from './token-verifier.js';

export interface Principal {
  userId: string;
  tenantId: string;
  email: string;
}

/**
 * Maps a verified Supabase identity to a local user and tenant. Rows are created lazily on the
 * first authenticated request (a database trigger on `auth.users` could block signups).
 */
export class IdentityService {
  private readonly prisma: PrismaClient;

  constructor(deps: { prisma: PrismaClient }) {
    this.prisma = deps.prisma;
  }

  async resolve(claims: AuthClaims): Promise<Principal> {
    const existing = await this.find(claims);
    if (existing) return existing;
    try {
      // Beta: one user = one tenant. The tenant name never carries personal data.
      await this.prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { id: claims.userId, email: claims.email } });
        const tenant = await tx.tenant.create({ data: { name: 'personal' } });
        await tx.tenantMember.create({ data: { tenantId: tenant.id, userId: claims.userId, role: 'OWNER' } });
      });
    } catch (e) {
      // A concurrent first request won the race; its committed rows are what we read next.
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
    const created = await this.find(claims);
    if (!created) throw new Error('identity resolution failed');
    return created;
  }

  private async find(claims: AuthClaims): Promise<Principal | null> {
    const member = await this.prisma.tenantMember.findUnique({
      where: { userId: claims.userId },
      include: { user: true },
    });
    if (!member) return null;
    if (member.user.email !== claims.email) {
      await this.prisma.user.update({ where: { id: claims.userId }, data: { email: claims.email } });
    }
    return { userId: claims.userId, tenantId: member.tenantId, email: claims.email };
  }
}
