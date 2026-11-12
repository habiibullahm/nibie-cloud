# @hermes-cloud/docs

Customer documentation for Nibie Cloud (Hermes Cloud), served at `cloud.nibie.app/docs`.
Fumadocs (Next.js 16, Tailwind v4), content in Indonesian, themed from the root `DESIGN.md`.
Standalone package like `apps/web`: its own `package.json` and lockfile, not a workspace member.

```bash
cd apps/docs
pnpm install
pnpm dev          # http://localhost:3200/docs
pnpm typecheck && pnpm lint
pnpm build        # static export to out/ (no Node server needed)
```

- Content: `content/docs/(panduan)` (guide, URL root) and `content/docs/api-reference`. Sidebar order is
  in each folder's `meta.json`.
- Source of truth for content is `docs/prd.md` and the backend specs. Do not document a feature, price
  or limit that is not decided there; mark unfinished features with a `Draft` callout.
- `basePath` is `/docs`, so the export must be hosted under `/docs` (the files in `out/` are served as
  `cloud.nibie.app/docs/*`). `out/<page>.html` must resolve for `/docs/<page>` (extensionless URLs).
- Search is a static index built at build time (`/docs/api/search`), queried in the browser.
- Theme: `src/app/global.css` maps `DESIGN.md` tokens onto fumadocs-ui's shadcn preset. Dark only.
  Terracotta is not used here; active states and links are neutral.

Not done: no deployment (Cloudflare route for `/docs*`) is configured, and `@google/design.md` lint
has not been run for this package.
