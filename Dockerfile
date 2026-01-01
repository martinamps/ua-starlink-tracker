FROM oven/bun:slim

WORKDIR /app

# Install Chromium runtime dependencies (required for Playwright's browser)
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
RUN bun install

# Install Playwright's bundled Chromium (guaranteed compatible)
RUN bunx playwright install chromium

COPY . .

EXPOSE 3000

ENV NODE_ENV=production
ENV LOG_DIR=/srv/ua-starlink-tracker/logs

CMD ["bun", "run", "server.ts"]
