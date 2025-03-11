FROM oven/bun:1.1-slim

# Create the working directory
WORKDIR /app

# Copy package manifest & lock file
COPY package.json .
COPY bun.lockb .

# Install dependencies
RUN bun install

# Copy the rest of the files
COPY . .

# Create directory for SQLite database
RUN mkdir -p /srv/ua-starlink-tracker

# Expose port
EXPOSE 3000

# Set production environment for docker
ENV NODE_ENV=production

# Start the server
CMD ["bun", "run", "server.ts"]