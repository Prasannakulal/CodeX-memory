import IORedis from "ioredis";
import { Queue } from "bullmq";
import client from "prom-client";
import config from "./config.js";

const metricKey = "codexmemory:metrics:ingestion";
const durationBuckets = [0.5, 1, 2, 5, 10, 30, 60];

const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
});

const ingestionQueue = new Queue("document-ingestion", { connection });

let metricsClosed = false;

client.collectDefaultMetrics();

export async function recordIngestionMetrics(status, durationSeconds) {
  const pipeline = connection.multi();

  pipeline.hincrby(metricKey, `jobs_total:${status}`, 1);
  pipeline.hincrbyfloat(metricKey, "duration_sum", durationSeconds);
  pipeline.hincrby(metricKey, "duration_count", 1);

  for (const bucket of durationBuckets) {
    if (durationSeconds <= bucket) {
      pipeline.hincrby(metricKey, `duration_bucket:${bucket}`, 1);
    }
  }

  await pipeline.exec();
}

export async function recordIngestionRetry() {
  await connection.hincrby(metricKey, "retries_total", 1);
}

export async function recordDeadLetterJob() {
  await connection.hincrby(metricKey, "dead_letter_jobs_total", 1);
}

export async function closeMetrics() {
  if (metricsClosed) return;

  metricsClosed = true;
  await ingestionQueue.close();

  if (connection.status !== "end") {
    await connection.quit();
  }
}

export async function getMetrics() {
  const [defaultMetrics, storedMetrics, queueCounts] = await Promise.all([
    client.register.metrics(),
    connection.hgetall(metricKey),
    ingestionQueue.getJobCounts("waiting", "active", "completed", "failed"),
  ]);

  const value = (name) => storedMetrics[name] ?? "0";
  const ingestionMetrics = [
    "# HELP codexmemory_ingestion_jobs_total Total number of ingestion jobs processed",
    "# TYPE codexmemory_ingestion_jobs_total counter",
    `codexmemory_ingestion_jobs_total{status="success"} ${value("jobs_total:success")}`,
    `codexmemory_ingestion_jobs_total{status="failed"} ${value("jobs_total:failed")}`,
    "# HELP codexmemory_ingestion_duration_seconds Time spent processing ingestion jobs",
    "# TYPE codexmemory_ingestion_duration_seconds histogram",
    ...durationBuckets.map(
      (bucket) =>
        `codexmemory_ingestion_duration_seconds_bucket{le="${bucket}"} ${value(`duration_bucket:${bucket}`)}`
    ),
    `codexmemory_ingestion_duration_seconds_bucket{le="+Inf"} ${value("duration_count")}`,
    `codexmemory_ingestion_duration_seconds_sum ${value("duration_sum")}`,
    `codexmemory_ingestion_duration_seconds_count ${value("duration_count")}`,
    "# HELP codexmemory_ingestion_retries_total Total number of ingestion job retry attempts",
    "# TYPE codexmemory_ingestion_retries_total counter",
    `codexmemory_ingestion_retries_total ${value("retries_total")}`,
    "# HELP codexmemory_dead_letter_jobs_total Total number of ingestion jobs recorded in the dead-letter queue",
    "# TYPE codexmemory_dead_letter_jobs_total counter",
    `codexmemory_dead_letter_jobs_total ${value("dead_letter_jobs_total")}`,
  ];

  const queueDepthMetrics = [
    "# HELP codexmemory_ingestion_queue_jobs Current number of jobs in the ingestion queue by state",
    "# TYPE codexmemory_ingestion_queue_jobs gauge",
    `codexmemory_ingestion_queue_jobs{state="waiting"} ${queueCounts.waiting}`,
    `codexmemory_ingestion_queue_jobs{state="active"} ${queueCounts.active}`,
    `codexmemory_ingestion_queue_jobs{state="completed"} ${queueCounts.completed}`,
    `codexmemory_ingestion_queue_jobs{state="failed"} ${queueCounts.failed}`,
  ];

  return `${defaultMetrics}\n${ingestionMetrics.join("\n")}\n${queueDepthMetrics.join("\n")}\n`;
}
