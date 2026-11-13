# syntax=docker/dockerfile:1.7
# Hermes Cloud backend (control plane), single-VPS deployment.
# Build context is the repository root; deploy/Dockerfile.dockerignore limits it to an allowlist.
FROM node:22-bookworm-slim

# openssl: needed by the Prisma engine. ca-certificates: TLS to Supabase.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
# devDependencies MUST be installed: there is no build step (tsx runs src/ directly) and the Prisma CLI is
# used for migrations. Do not set NODE_ENV=production before this line (pnpm would skip devDependencies).
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/main.ts"]
