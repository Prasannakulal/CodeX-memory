import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  redis: {
    url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
  },
  docs: {
    dir: process.env.DOCS_DIR
      ? resolve(process.cwd(), process.env.DOCS_DIR)
      : join(__dirname, "../docs"),
  },
  database: {
    path: process.env.LANCEDB_PATH || "./data/lancedb",
  },
  graphDatabase: {
    path: process.env.KUZU_PATH || "./data/kuzudb",
  },
  metrics: {
    port: parsePositiveInt(process.env.METRICS_PORT, 9090),
  },
  worker: {
    concurrency: parsePositiveInt(process.env.WORKER_CONCURRENCY, 1),
  },
  queue: {
    attempts: parsePositiveInt(process.env.INGESTION_RETRY_ATTEMPTS, 3),
    backoffDelay: parsePositiveInt(process.env.INGESTION_RETRY_DELAY, 1000),
  },
  logging: {
    level: process.env.LOG_LEVEL || "info",
  },
  mcp: {
    port: parsePositiveInt(process.env.MCP_PORT, 3001),
    host: process.env.MCP_HOST || "127.0.0.1",
    endpoint: "/mcp",
    authToken: process.env.MCP_AUTH_TOKEN || undefined,
    transport: process.env.MCP_TRANSPORT || "http",
  },
};

export default config;
