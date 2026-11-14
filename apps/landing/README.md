# @hermes-cloud/landing

Public landing page for **https://cloud.nibie.app** (the root). Product name: Hermes Cloud, published by
Nibie (`nibie.app`). Content is in Indonesian. It also carries the pages the Duitku merchant review asks
for: prices in rupiah, contact, Terms of Service, refund policy and privacy policy.

Standalone package, like `apps/web` and `apps/docs` (own `package.json`, own lockfile, no pnpm workspace).
Read the root `DESIGN.md` before any UI change. shadcn/ui is the only component foundation.

| Route | Page |
| --- | --- |
| `/` | Hero, features, how it works, prices, FAQ |
| `/harga` | Prices |
| `/kontak` | Contact |
| `/syarat-layanan`, `/kebijakan-refund`, `/kebijakan-privasi` | Legal (drafts: the owner reads them before publishing) |

## Commands

```bash
cd apps/landing
pnpm install
pnpm dev                 # http://localhost:3300
pnpm typecheck && pnpm lint && pnpm test
pnpm build               # static export into out/
npx wrangler dev         # serves out/ exactly like the Worker (run pnpm build first)
```

## Where the content lives

- Prices, plan specs and the beta size: `src/lib/plans.ts` (the only place with numbers; covered by tests).
- Product name, operator, links, legal date: `src/lib/site.ts`. Update `legalUpdated` whenever a legal text changes.
- Copy: `src/components/site/*` and `src/app/*/page.tsx`.
- The hero grid and the light motion (CSS only, off under `prefers-reduced-motion`): the bottom of `src/app/globals.css`.
- `display`, `h2` and `lead` are marketing type tokens added to `DESIGN.md` for this package only.

## Public contact email: never in the repository

The repository is public. The contact address is read from the build variable `NEXT_PUBLIC_CONTACT_EMAIL`
(`.env.example` has the name only). Next.js inlines it at build time, so changing it needs a rebuild. When it
is empty or malformed the site hides the address and the "Minta akses beta" buttons open Telegram instead.

## Deploy: Cloudflare Worker `nibie-cloud-landing`

Static assets only (`wrangler.jsonc`, no `main`). The Worker name in the dashboard must equal `name` there.

1. Workers Builds, new project from `habiibullahm/nibie-cloud`, **root directory `apps/landing`**,
   build command `pnpm install && pnpm build`, deploy command `pnpm exec wrangler deploy`, preview builds off.
2. Build variable `NEXT_PUBLIC_CONTACT_EMAIL` (the public address). Rebuild after changing it.
3. Route `cloud.nibie.app/*` to `nibie-cloud-landing`. The dashboard route `cloud.nibie.app/dashboard*` and
   the future `/docs*` route are more specific, so they keep winning. The proxied `cloud` DNS record already exists.

Not verified yet: the real Cloudflare build and route (everything above was checked locally with `wrangler dev`).
