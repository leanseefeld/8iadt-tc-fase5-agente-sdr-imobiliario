# syntax=docker/dockerfile:1

# One image, two processes. `app` and `worker` differ only by the command they
# are started with — see docker-compose.yml.

FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# The full install, dev dependencies included. Its own stage so the layer is
# keyed on the lockfile alone: a source change never re-runs `npm ci`, and the
# npm cache mount makes a lockfile change download only what changed.
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# Development: sources arrive by bind mount, node_modules and .next stay in
# named volumes so host and container never share compiled output.
FROM deps AS dev
COPY . .
EXPOSE 3100 3101
CMD ["npm", "run", "dev"]

# `next build` is also the only type-checking gate in a project with no CI.
# `.next/cache` is a cache mount, so incremental builds reuse it without it
# ever reaching an image layer.
FROM deps AS build
COPY . .
RUN --mount=type=cache,target=/app/.next/cache npm run build
# The worker, the migration runner and the seed are plain Node entrypoints.
# Bundled, they carry their own dependencies and need no node_modules at all.
RUN npm run build:jobs

# Production: nothing that isn't read at run time. The standalone server
# (`output: "standalone"`) brings only the packages it traced to; the three
# bundles bring theirs. Ordered from least to most often changed, so a deploy
# re-ships the layers that changed and reuses the rest.
#
#   app      CMD below
#   worker   node dist/worker/index.js
#   migrate  node dist/db/migrate.js
#   seed     node dist/db/seed/index.js
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
# Read at run time through process.cwd(): model profiles, the migration files
# (applied by migrate, compared by both readiness checks) and the seed catalog.
COPY config ./config
COPY src/db/migrations ./src/db/migrations
COPY src/db/seed/properties.json ./src/db/seed/properties.json
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3100 3101
# `server.js` reads PORT; the app's contract is APP_PORT (core/config.ts).
CMD ["sh", "-c", "PORT=${APP_PORT:-3100} exec node server.js"]
