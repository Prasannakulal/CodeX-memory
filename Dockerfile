FROM node:20-bookworm-slim

WORKDIR /app

# Install ca-certificates and curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Ensure storage and docs directories exist
RUN mkdir -p docs data/lancedb

# Expose Streamable HTTP MCP server (3001) and Prometheus metrics server (9090)
EXPOSE 3001 9090

# Start all CodexMemory services concurrently (metrics-server, worker, watcher, mcp-server)
CMD ["npm", "run", "dev"]
