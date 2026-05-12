# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json ./
RUN pnpm install --no-frozen-lockfile

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

RUN pnpm build

# --- runtime stage ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Force IPv4-first DNS — some hosts (spare DigitalOcean) return AAAA but have no v6 route.
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json ./
RUN pnpm install --prod --no-frozen-lockfile

COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle

EXPOSE 8090
CMD ["node", "dist/server.js"]
