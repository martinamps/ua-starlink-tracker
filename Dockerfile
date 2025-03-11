FROM oven/bun:1.1-slim

# Create the working directory
WORKDIR /app

# Copy package manifest
COPY package.json .

# Install dependencies (this will generate bun.lockb)
RUN bun install

# Copy the rest of the files
COPY . .

# The /srv/ua-starlink-tracker directory will be mounted from the host

# Expose port
EXPOSE 3000

# Set production environment for docker
ENV NODE_ENV=production

# Start the server
CMD ["bun", "run", "server.ts"]