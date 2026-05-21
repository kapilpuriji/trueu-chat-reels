FROM node:20-slim

# Install Chromium, FFmpeg, and all rendering dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
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
    libasound2 \
    libxshmfence1 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxss1 \
    libxtst6 \
    xvfb \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Remotion where Chromium is and skip downloading another one
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Give Node more memory for bundling + rendering
ENV NODE_OPTIONS=--max-old-space-size=2048

# Chromium needs --no-sandbox when running as root in Docker
ENV CHROMIUM_FLAGS="--no-sandbox --disable-gpu --disable-dev-shm-usage"

WORKDIR /app

# Install dependencies first (cached if package files don't change)
COPY package.json package-lock.json ./
RUN npm ci

# Copy project files
COPY . .

# Pre-bundle at build time so server starts instantly
RUN node prebundle.mjs

EXPOSE 3000

CMD ["node", "server.mjs"]