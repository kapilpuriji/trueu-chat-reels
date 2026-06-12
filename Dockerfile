# Pin to bookworm so libasound2 / libatk* package names stay stable.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libxshmfence1 \
    --no-install-recommends \
    && (apt-get install -y libasound2 || apt-get install -y libasound2t64 || true) \
    && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_OPTIONS=--max-old-space-size=2048
# Railway injects PORT; keep a sane default for local docker runs.
ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Pre-bundle the Remotion project so the container starts fast on Railway
# (otherwise the first request after deploy times out on Railway's healthcheck).
RUN node prebundle.mjs

EXPOSE 3000

CMD ["node", "server.mjs"]
