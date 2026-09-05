# syntax=docker/dockerfile:1

# One image, two processes. `app` and `worker` differ only by the command they
# are started with — see docker-compose.yml.

FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Development: sources arrive by bind mount, node_modules and .next stay in
# named volumes so host and container never share compiled output.
FROM base AS dev
COPY . .
EXPOSE 3000 3001
CMD ["npm", "run", "dev"]

FROM base AS build
COPY . .
RUN npm run build

# Production parity. Not used by `docker compose up`; it exists so the claim
# "the same containers run in the cloud" is testable, and because `next build`
# is the only type-checking gate in a project with no CI.
FROM base AS runner
ENV NODE_ENV=production
COPY . .
COPY --from=build /app/.next ./.next
EXPOSE 3000 3001
CMD ["npm", "run", "start"]
