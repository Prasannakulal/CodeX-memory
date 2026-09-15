import express from "express";
import config from "./config.js";
import { closeMetrics, getMetrics } from "./metrics.js";

const app = express();

app.get("/metrics", async (_request, response) => {
  response.set("Content-Type", "text/plain");

  response.send(await getMetrics());
});

const port = config.metrics.port;

const server = app.listen(port, () => {
  console.log(`Metrics server listening on http://localhost:${port}`);
});

let shuttingDown = false;

function closeHttpServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    console.log("Metrics server shutdown is already in progress");
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; stopping metrics server`);

  try {
    await closeHttpServer();
    console.log("Metrics HTTP server closed");

    await closeMetrics();
    console.log("Metrics Redis connection closed");
  } catch (error) {
    console.error("Metrics server shutdown failed:", error);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
