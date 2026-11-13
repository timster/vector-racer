# One image runs everything: the API, the live WebSocket and the built game, from one Node process.

FROM node:26-alpine AS build
WORKDIR /app
# Install with every workspace's manifest first, so dependency layers cache between code changes.
COPY package.json package-lock.json ./
COPY packages/sim/package.json packages/sim/
COPY packages/tracks/package.json packages/tracks/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/replay-cli/package.json tools/replay-cli/
RUN npm ci
COPY . .
# Builds apps/web/dist (the game) and apps/server/dist/server.js (sim and tracks bundled in).
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
# The server bundle leaves fastify, its plugins and pg external: install just those.
COPY package.json package-lock.json ./
COPY packages/sim/package.json packages/sim/
COPY packages/tracks/package.json packages/tracks/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/replay-cli/package.json tools/replay-cli/
RUN npm ci --omit=dev --workspace=@vector-racer/server && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
ENV STATIC_DIR=/app/apps/web/dist
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/server.js"]
