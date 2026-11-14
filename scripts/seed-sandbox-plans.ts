/**
 * Sets a SANDBOX test price on a plan so Duitku checkout can be tried end to end.
 *
 *   pnpm tsx scripts/seed-sandbox-plans.ts                     # lists plans and prices, changes nothing
 *   pnpm tsx scripts/seed-sandbox-plans.ts <slug> <price-idr>  # sets the price (whole rupiah, at least 10000)
 *   pnpm tsx scripts/seed-sandbox-plans.ts <slug> none         # makes the plan not for sale again
 *
 * Prices are an explicit operator step (PRD 5.2: pricing is not approved), never part of a migration.
 * Refuses to run against a production backend or the production Duitku environment.
 */
import { createPrisma } from '../src/db/client.js';
import { DUITKU_MIN_AMOUNT_IDR } from '../src/modules/billing/duitku-client.js';

if (process.env.NODE_ENV === 'production' || process.env.DUITKU_ENV === 'production') {
  console.error('Refusing to set a test price: NODE_ENV or DUITKU_ENV is production. Production prices are set by hand once approved.');
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const [slug, rawPrice] = process.argv.slice(2);
const prisma = createPrisma(databaseUrl);
try {
  if (!slug) {
    const plans = await prisma.plan.findMany({ orderBy: { slug: 'asc' } });
    for (const p of plans) console.log(`${p.slug}\tactive=${p.active}\tmonthlyPriceIdr=${p.monthlyPriceIdr ?? 'none (not for sale)'}`);
  } else {
    let price: number | null;
    if (rawPrice === 'none') price = null;
    else if (rawPrice && /^\d+$/.test(rawPrice) && Number(rawPrice) >= DUITKU_MIN_AMOUNT_IDR) price = Number(rawPrice);
    else {
      console.error(`Price must be a whole number of rupiah of at least ${DUITKU_MIN_AMOUNT_IDR}, or "none".`);
      process.exit(1);
    }
    const plan = await prisma.plan.findUnique({ where: { slug } });
    if (!plan) {
      console.error(`No plan with slug "${slug}".`);
      process.exit(1);
    }
    await prisma.plan.update({ where: { id: plan.id }, data: { monthlyPriceIdr: price } });
    console.log(`${slug}: monthlyPriceIdr ${plan.monthlyPriceIdr ?? 'none'} -> ${price ?? 'none'} (sandbox test price, not an approved price)`);
  }
} finally {
  await prisma.$disconnect();
}
