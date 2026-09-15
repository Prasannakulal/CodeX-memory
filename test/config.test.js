import assert from "node:assert/strict";
import test from "node:test";

import config from "../src/config.js";

test("config provides default values matching existing behavior", () => {
  assert.equal(config.redis.url, "redis://127.0.0.1:6379");
  assert.equal(config.ollama.baseUrl, "http://localhost:11434");
  assert.equal(config.ollama.model, "nomic-embed-text");
  assert.ok(config.docs.dir.endsWith("docs"));
  assert.equal(config.database.path, "./data/lancedb");
  assert.equal(config.metrics.port, 9090);
  assert.equal(config.worker.concurrency, 1);
  assert.equal(config.queue.attempts, 3);
  assert.equal(config.queue.backoffDelay, 1000);
  assert.equal(config.logging.level, "info");
});
