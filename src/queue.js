import { Queue } from "bullmq";
import IORedis from "ioredis";
import config from "./config.js";
import { EventEmitter } from "node:events";

export const memoryQueueEvents = new EventEmitter();

// In-memory queue state for zero-Docker / offline fallback
const memoryQueue = {
  waiting: [],
  active: new Set(),
  completedCount: 0,
  failedCount: 0,
};

let redisAvailable = false;
let isProcessingMemoryQueue = false;

// Initialize Redis connection with silent error handling (no unhandled ECONNREFUSED)
export const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
  retryStrategy(times) {
    if (times > 3) {
      // Back off if Redis isn't running
      return 10000;
    }
    return Math.min(times * 500, 3000);
  },
});

connection.on("ready", () => {
  redisAvailable = true;
});

connection.on("error", (_err) => {
  redisAvailable = false;
});

connection.on("close", () => {
  redisAvailable = false;
});

export const ingestionQueue = new Queue("document-ingestion", {
  connection,
});

// Provide fallback for getJobCounts on ingestionQueue
const originalGetJobCounts = ingestionQueue.getJobCounts.bind(ingestionQueue);
ingestionQueue.getJobCounts = async (...types) => {
  if (redisAvailable && connection.status === "ready") {
    try {
      return await originalGetJobCounts(...types);
    } catch {
      // Fall through to memory counts
    }
  }
  return {
    waiting: memoryQueue.waiting.length,
    active: memoryQueue.active.size,
    completed: memoryQueue.completedCount,
    failed: memoryQueue.failedCount,
  };
};

let queueClosed = false;

export async function closeIngestionQueue() {
  if (queueClosed) return;
  queueClosed = true;

  try {
    await ingestionQueue.close();
  } catch {}

  try {
    if (connection.status !== "end") {
      await connection.quit();
    }
  } catch {}
}

/**
 * Process memory queue jobs sequentially if Redis is offline
 */
async function processNextMemoryJob() {
  if (isProcessingMemoryQueue || memoryQueue.waiting.length === 0) return;
  isProcessingMemoryQueue = true;

  const job = memoryQueue.waiting.shift();
  if (!job) {
    isProcessingMemoryQueue = false;
    return;
  }

  memoryQueue.active.add(job.id);
  memoryQueueEvents.emit("active", job);

  try {
    // Dynamic import to avoid circular dependencies
    const { ingestFile } = await import("./ingest.js");
    const db = (await import("./database.js")).default;
    await ingestFile(job.data.filePath, { database: db });
    memoryQueue.completedCount++;
    memoryQueueEvents.emit("completed", job);
  } catch (err) {
    console.warn(`[memory-queue] Failed to process ${job.data.filePath}:`, err.message);
    memoryQueue.failedCount++;
    memoryQueueEvents.emit("failed", job, err);
  } finally {
    memoryQueue.active.delete(job.id);
    isProcessingMemoryQueue = false;
    if (memoryQueue.waiting.length > 0) {
      setImmediate(processNextMemoryJob);
    }
  }
}

/**
 * Adds a document ingestion job.
 * Uses BullMQ if Redis is active; otherwise seamlessly processes in memory.
 */
export async function queueDocument(filePath) {
  if (redisAvailable && connection.status === "ready") {
    try {
      return await ingestionQueue.add(
        "ingest-document",
        { filePath },
        {
          attempts: config.queue.attempts,
          backoff: {
            type: "exponential",
            delay: config.queue.backoffDelay,
          },
          removeOnComplete: 100,
          removeOnFail: 100,
        }
      );
    } catch {
      // If BullMQ fails to enqueue, fall through to memory queue
    }
  }

  // In-memory queue fallback
  const job = {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    data: { filePath },
    timestamp: Date.now(),
  };

  memoryQueue.waiting.push(job);
  memoryQueueEvents.emit("waiting", job);
  setImmediate(processNextMemoryJob);

  return job;
}
