# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    FFMPEG_BIN=/usr/bin/ffmpeg

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        ffmpeg \
        fonts-noto-core \
        fonts-noto-color-emoji \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS dependencies

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        g++ \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS development

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
RUN install -d -o node -g node /app/data
USER node
CMD ["npm", "run", "dev"]

FROM dependencies AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM base AS runtime
ARG BUILD_REVISION=unknown
ARG BUILD_VERSION=1.0.0
LABEL org.opencontainers.image.source=https://github.com/ti014/zalo-tg
LABEL org.opencontainers.image.version=${BUILD_VERSION}
LABEL org.opencontainers.image.revision=${BUILD_REVISION}

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    DATA_DIR=/app/data \
    HEALTH_DIR=/tmp/health \
    ZALO_CREDENTIALS_PATH=/app/data/credentials.json \
    HOME=/tmp/home \
    TMPDIR=/tmp \
    PUPPETEER_TMP_DIR=/tmp \
    UPDATE_CHECK_ENABLED=false \
    TZ=Asia/Bangkok

RUN groupadd --gid 10001 bridge \
    && useradd --uid 10001 --gid bridge \
        --home-dir /nonexistent \
        --no-create-home \
        --shell /usr/sbin/nologin bridge \
    && install -d -o 10001 -g 10001 /app/data

COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/package-lock.json ./package-lock.json
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "dist/runtime/healthcheck.js"]

CMD ["node", "dist/index.js"]
