# Charter: one image with the API, the MCP endpoint and the Angular UI.
# The repository is one npm workspace (server, web, packages/contracts) with a single lockfile.

FROM node:24-alpine AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/ packages/contracts/
COPY server/package.json server/
COPY web/package.json web/

FROM manifests AS web
RUN npm ci -w web
COPY web/ web/
RUN npm run build -w web

FROM manifests AS server
RUN npm ci -w server
COPY server/ server/
RUN npm run build -w server

# Production dependencies only. The shared types are compile-time only and are not needed here.
FROM manifests AS server-deps
RUN npm ci -w server --omit=dev && mkdir -p server/node_modules

FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    CHARTER_WEB_DIR=/app/web \
    CHARTER_MIGRATIONS_DIR=/app/server/migrations
WORKDIR /app/server
COPY --from=server-deps /app/node_modules /app/node_modules
# Anything npm had to nest under the server instead of hoisting (usually empty).
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/migrations ./migrations
COPY --from=server /app/server/package.json ./
COPY --from=web /app/web/dist/web/browser /app/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/index.js"]
