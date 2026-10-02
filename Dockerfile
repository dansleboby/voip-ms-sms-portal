# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain only used if better-sqlite3 has no prebuilt binary for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIR=/app/dist/web
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/sms-portal-entrypoint
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Starts as root only to fix the data folder's owner, then runs as "node" (or PUID/PGID).
ENTRYPOINT ["sms-portal-entrypoint"]
CMD ["node", "dist/node/server/index.js"]
