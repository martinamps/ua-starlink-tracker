FROM oven/bun:1.3.13-slim

WORKDIR /app

# Install Chromium runtime dependencies (required for Playwright's browser)
# plus curl + unzip (FAA registry job downloads and streams the daily bulk zip)
# and tini (PID 1; see ENTRYPOINT)
RUN apt-get update && apt-get install -y \
    tini \
    curl \
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
    unzip \
    && rm -rf /var/lib/apt/lists/*

# bun.lock is what CI's tests ran under. A plain `bun install` here once took
# whatever was newest on build day (Playwright six minors past the lockfile), so
# two builds of one commit differed and a revert didn't bring its packages back.
# --frozen-lockfile fails the build if package.json and bun.lock disagree.
# tests/dockerfile-init.test.ts keeps these lines.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install Playwright's bundled Chromium to the same path used by scripts
ENV PLAYWRIGHT_BROWSERS_PATH=/app/do_not_commit/playwright-browsers
RUN bunx playwright install chromium

COPY . .

# Tailwind is compiled here rather than committed: the CSS is derived from the
# markup in this image, so a branch that adds a page can never ship without the
# utilities it uses. server.ts refuses to boot in production if this is missing.
RUN bun run build:css

EXPOSE 3000

ARG SOURCE_COMMIT=unknown

ENV NODE_ENV=production
ENV LOG_DIR=/srv/ua-starlink-tracker/logs

# Datadog APM configuration
ENV DD_ENV=prod
ENV DD_SERVICE=ua-starlink-tracker
ENV DD_VERSION=${SOURCE_COMMIT}
ENV DD_GIT_COMMIT_SHA=${SOURCE_COMMIT}
ENV DD_GIT_REPOSITORY_URL=github.com/martinamps/ua-starlink-tracker
ENV DD_TRACE_AGENT_HOSTNAME=host.docker.internal
ENV DD_RUNTIME_METRICS_ENABLED=false

# Every United check leaves Chromium helpers orphaned; they are re-parented to
# PID 1, and Bun never reaps children it didn't spawn, so each became a zombie
# for the container's life (~1,700 a day, ~55 KB kernel memory each, toward the
# container's task limit). tini reaps them and forwards SIGTERM to the server.
# tests/dockerfile-init.test.ts keeps this line.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "--smol", "server.ts"]
