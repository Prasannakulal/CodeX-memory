import { Queue } from "bullmq";
import IORedis from "ioredis";
import config from "./config.js";

export const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
});

export const ingestionQueue = new Queue("document-ingestion", {
  connection,
});

let queueClosed = false;

export async function closeIngestionQueue() {
  if (queueClosed) return;

  queueClosed = true;
  await ingestionQueue.close();

  if (connection.status !== "end") {
    await connection.quit();
  }
}

export async function queueDocument(filePath) {
  return ingestionQueue.add(
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
}
