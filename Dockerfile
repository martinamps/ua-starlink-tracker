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

# Install Playwright's bundled Chromium to the same path used by scripts
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN bunx playwright install chromium

COPY . .

EXPOSE 3000

# Coolify passes SOURCE_COMMIT automatically
ARG SOURCE_COMMIT=unknown

ENV NODE_ENV=production
ENV LOG_DIR=/srv/ua-starlink-tracker/logs

# Datadog APM configuration
ENV DD_ENV=production
ENV DD_SERVICE=ua-starlink-tracker
ENV DD_VERSION=${SOURCE_COMMIT}
ENV DD_TRACE_AGENT_HOSTNAME=host.docker.internal
ENV DD_RUNTIME_METRICS_ENABLED=false

CMD ["bun", "run", "server.ts"]
