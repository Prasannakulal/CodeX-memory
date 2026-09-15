import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const services = [
  { name: "metrics-server", script: "src/metrics-server.js", color: "\x1b[36m" },
  { name: "worker",         script: "src/worker.js",         color: "\x1b[33m" },
  { name: "watcher",        script: "src/watcher.js",        color: "\x1b[32m" },
  { name: "mcp-server",     script: "src/server.js",         color: "\x1b[34m" },
];

const reset = "\x1b[0m";
const children = [];

for (const svc of services) {
  const child = spawn("node", [svc.script], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = `${svc.color}[${svc.name}]${reset}`;

  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      console.log(`${prefix} ${line}`);
    }
  });

  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      console.error(`${prefix} ${line}`);
    }
  });

  child.on("exit", (code, signal) => {
    console.log(`${prefix} exited (code=${code}, signal=${signal})`);
  });

  children.push(child);
}

console.log("\x1b[35m[dev]\x1b[0m All services started. Press Ctrl+C to stop.\n");

function shutdown() {
  console.log("\n\x1b[35m[dev]\x1b[0m Shutting down all services...");
  for (const child of children) {
    if (!child.killed) child.kill("SIGINT");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
