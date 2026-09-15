import chokidar from "chokidar";
import config from "./config.js";
import { closeIngestionQueue, queueDocument } from "./queue.js";
import { deleteDocument } from "./delete-document.js";

const docsDirectory = config.docs.dir;

const watcher = chokidar.watch(docsDirectory, {
  persistent: true,
  ignoreInitial: false,
  ignored: (filePath, stats) =>
    stats?.isFile() && !filePath.endsWith(".md"),
});

let shuttingDown = false;

watcher
  .on("ready", () => {
    console.log("Watcher is ready and watching the docs directory");
  })

  .on("add", async (filePath) => {
    if (shuttingDown || !filePath.endsWith(".md")) return;

    console.log(`New document detected: ${filePath}`);

    try {
      const job = await queueDocument(filePath);
      console.log(`Queued ingestion job ${job.id}`);
    } catch (error) {
      console.error("Failed to queue new document:", error.message);
    }
  })

  .on("change", async (filePath) => {
    if (shuttingDown || !filePath.endsWith(".md")) return;

    console.log(`Document changed: ${filePath}`);

    try {
      const job = await queueDocument(filePath);
      console.log(`Queued ingestion job ${job.id}`);
    } catch (error) {
      console.error("Failed to queue changed document:", error.message);
    }
  })

  .on("unlink", async (filePath) => {
    if (shuttingDown || !filePath.endsWith(".md")) return;

    console.log(`Document deleted: ${filePath}`);

    try {
      await deleteDocument(filePath);
    } catch (error) {
      console.error("Failed to delete document from index:", error.message);
    }
  })

  .on("error", (error) => {
    console.error("WATCHER ERROR:", error);
  });

async function shutdown(signal) {
  if (shuttingDown) {
    console.log("Watcher shutdown is already in progress");
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; stopping document watcher`);

  try {
    await watcher.close();
    console.log("Document watcher closed");

    await closeIngestionQueue();
    console.log("Document ingestion queue connection closed");
  } catch (error) {
    console.error("Watcher shutdown failed:", error);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
