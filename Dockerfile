# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG APP_UID=7333

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# The entrypoint is `node dist/index.js` — npm/npx/yarn are never invoked at
# runtime, but node:24-alpine bundles them anyway, and their own dependency
# trees (not this app's — `npm audit --omit=dev` is clean) are what a Trivy
# scan of the published image actually flags. Must run after `npm ci` above,
# which still needs npm; removing it earlier breaks the build.
RUN rm -rf \
  /usr/local/lib/node_modules/npm \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  /opt/yarn-v1.22.22

COPY --from=build /app/dist ./dist

# Rootless, own UID:GID. /app/data is the only writable path: the container
# is meant to run with --read-only (CI asserts this).
RUN addgroup -S -g ${APP_UID} riffado-mcp \
  && adduser -S -D -H -u ${APP_UID} -G riffado-mcp riffado-mcp \
  && mkdir -p /app/data \
  && chown -R riffado-mcp:riffado-mcp /app/data

ENV TRANSPORT=http
ENV HTTP_HOST=0.0.0.0
ENV HTTP_OAUTH_STATE_FILE=/app/data/oauth-state.json

# JSON/exec form: shell form trips hadolint DL3025.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+((process.env.HTTP_PORT||'').trim()||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

USER 7333

ENTRYPOINT ["node", "dist/index.js"]
