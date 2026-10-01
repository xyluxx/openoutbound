# syntax=docker/dockerfile:1

# OpenOutbound engine image: HTTP server (REST + MCP) and worker in one process.
# Build:  docker build -t openoutbound .
# Run:    docker compose up -d   (see docker-compose.yml and docs/guides/deploy.md)

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7331
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
COPY drizzle ./drizzle
COPY skills ./skills
RUN mkdir -p /app/.openoutbound && chown -R node:node /app/.openoutbound
USER node
EXPOSE 7331
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7331)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["serve"]
