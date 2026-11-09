# OpenPurpose: one image with the API, the MCP endpoint and the Angular UI.
# The repository is one npm workspace (apps/server, apps/web, packages/contracts) with a single
# lockfile. The OpenStuff packages come from npm.

FROM node:24-alpine AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/ packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

FROM manifests AS web
RUN npm ci -w apps/web
COPY apps/web/ apps/web/
# The release this image is built from. The web app knows it; a local build keeps 'unknown'.
ARG VERSION=unknown
RUN printf "/** The release this build came from. Docker sets it from the tag; a local build keeps 'unknown'. */\nexport const APP_VERSION = '%s';\n" "$VERSION" > apps/web/src/app/build-version.ts \
    && npm run tokens -w apps/web && npm run build -w apps/web

FROM manifests AS server
RUN npm ci -w apps/server
COPY apps/server/ apps/server/
RUN npm run build -w apps/server

# Production dependencies only. The shared types are compile-time only and are not needed here.
FROM manifests AS server-deps
RUN npm ci -w apps/server --omit=dev && mkdir -p apps/server/node_modules

FROM node:24-alpine
ARG VERSION=unknown
ENV NODE_ENV=production \
    VERSION=${VERSION} \
    PORT=8080 \
    OPENPURPOSE_WEB_DIR=/app/web \
    OPENPURPOSE_MIGRATIONS_DIR=/app/apps/server/migrations \
    OPENPURPOSE_SKILLS_DIR=/app/agent/skills
WORKDIR /app/apps/server
COPY --from=server-deps /app/node_modules /app/node_modules
# Anything npm had to nest under the server instead of hoisting (usually empty).
COPY --from=server-deps /app/apps/server/node_modules ./node_modules
COPY --from=server /app/apps/server/dist ./dist
COPY --from=server /app/apps/server/migrations ./migrations
COPY --from=server /app/apps/server/package.json ./
COPY --from=web /app/apps/web/dist/web/browser /app/web
COPY agent/skills /app/agent/skills
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/index.js"]
