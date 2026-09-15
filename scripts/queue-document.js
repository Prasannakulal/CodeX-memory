import { ingestionQueue } from "../src/queue.js";
import config from "../src/config.js";

const filePath = process.argv[2] ?? "./docs/test.md";

const job = await ingestionQueue.add(
  "ingest-document",
  {
    filePath,
  },
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

console.log(`Queued job ${job.id} for ${filePath}`);

await ingestionQueue.close();