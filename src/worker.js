import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import db from "./database.js";
import { ingestFile } from "./ingest.js";
import logger from "./logger.js";
import {
  closeMetrics,
  recordDeadLetterJob,
  recordIngestionMetrics,
  recordIngestionRetry,
} from "./metrics.js";
import config from "./config.js";

const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
});

const deadLetterQueue = new Queue("document-ingestion-dlq", { connection });

const pendingDeadLetterWrites = new Set();
let shuttingDown = false;

const worker = new Worker(
  "document-ingestion",
  async (job) => {
    const startedAt = process.hrtime.bigint();
    let status = "failed";

    if (job.attemptsMade > 0) {
      try {
        await recordIngestionRetry();
      } catch (error) {
        logger.error(
          {
            jobId: job.id,
            error: error.message,
          },
          "Failed to record ingestion retry metric"
        );
      }
    }

    logger.info(
      {
        jobId: job.id,
        filePath: job.data.filePath,
      },
      "Starting ingestion job"
    );

    try {
      const { filePath } = job.data;
      const count = await ingestFile(filePath, { database: db });

      status = "success";

      logger.info(
        {
          jobId: job.id,
          filePath,
          chunksStored: count,
        },
        "Ingestion job completed"
      );

      return {
        filePath,
        chunksStored: count,
      };
    } catch (error) {
      logger.error(
        {
          jobId: job.id,
          error: error.message,
        },
        "Ingestion job failed"
      );

      throw error;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      try {
        await recordIngestionMetrics(status, durationSeconds);
      } catch (error) {
        logger.error(
          {
            jobId: job.id,
            error: error.message,
          },
          "Failed to record ingestion metrics"
        );
      }
    }
  },
  {
    connection,
    concurrency: config.worker.concurrency,
  }
);

worker.on("completed", (job, result) => {
  logger.info(
    {
      jobId: job.id,
      result,
    },
    "BullMQ job completed"
  );
});

worker.on("failed", async (job, error) => {
  logger.error(
    {
      jobId: job?.id,
      error: error.message,
    },
    "BullMQ job failed"
  );

  const configuredAttempts = job?.opts.attempts ?? 1;

  if (!job || job.attemptsMade < configuredAttempts) {
    return;
  }

  const deadLetterWrite = (async () => {
    try {
      const failedAt = job.finishedOn ?? Date.now();

      await deadLetterQueue.add(
        "dead-letter-ingestion",
        {
          originalJobId: job.id,
          filePath: job.data.filePath,
          jobName: job.name,
          errorMessage: error.message,
          attempts: job.attemptsMade,
          failedAt,
        },
        {
          jobId: `dlq-${job.id}-${failedAt}`,
        }
      );

      await recordDeadLetterJob();

      logger.info(
        {
          jobId: job.id,
          filePath: job.data.filePath,
          attempts: job.attemptsMade,
        },
        "Ingestion job recorded in dead-letter queue"
      );
    } catch (deadLetterError) {
      logger.error(
        {
          jobId: job.id,
          error: deadLetterError.message,
        },
        "Failed to record ingestion job in dead-letter queue"
      );
    }
  })();

  pendingDeadLetterWrites.add(deadLetterWrite);

  try {
    await deadLetterWrite;
  } finally {
    pendingDeadLetterWrites.delete(deadLetterWrite);
  }
});

logger.info("CodexMemory ingestion worker is running");

async function shutdown(signal) {
  if (shuttingDown) {
    logger.info("Worker shutdown is already in progress");
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Received shutdown signal; waiting for active jobs");

  try {
    await worker.close();
    logger.info("BullMQ worker closed");

    await Promise.all(pendingDeadLetterWrites);
    await deadLetterQueue.close();

    if (connection.status !== "end") {
      await connection.quit();
    }
    logger.info("Worker Redis connections closed");

    await closeMetrics();
    logger.info("Metrics Redis connection closed");
  } catch (error) {
    logger.error({ error: error.message }, "Worker shutdown failed");
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
