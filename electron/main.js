import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import { exec, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

let mainWindow = null;
let serverProcess = null;
let activeWorkers = [];

const execOptions = {
  cwd: projectRoot,
  env: {
    ...process.env,
    PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
  },
};

const workerServices = [
  { name: "worker",         script: "src/worker.js" },
  { name: "watcher",        script: "src/watcher.js" },
  { name: "metrics-server", script: "src/metrics-server.js" },
];

// ---------------------------------------------------------------------------
// Server — use utilityProcess.fork() so Electron's Node ABI is used.
// This is the root fix for the SIGSEGV: kuzu native bindings require the
// same V8/Node ABI that Electron uses, not the system node binary.
// ---------------------------------------------------------------------------
function startServer() {
  if (serverProcess && !serverProcess.killed) return;
  console.log("[Electron] Forking HTTP/MCP server via utilityProcess...");

  serverProcess = utilityProcess.fork(join(projectRoot, "src/server.js"), [], {
    cwd: projectRoot,
    env: execOptions.env,
    stdio: "pipe",
    serviceName: "codex-memory-server",
  });

  serverProcess.stdout?.on("data", (d) => {
    process.stdout.write(`[server] ${d}`);
  });

  serverProcess.stderr?.on("data", (d) => {
    process.stderr.write(`[server] ${d}`);
  });

  serverProcess.on("exit", (code) => {
    console.log(`[server] utility process exited (code=${code})`);
    serverProcess = null;
  });
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Workers — system node is fine here (no native addons in these scripts)
// ---------------------------------------------------------------------------
function startWorkers() {
  stopWorkers();
  for (const svc of workerServices) {
    try {
      const child = spawn("node", [join(projectRoot, svc.script)], {
        cwd: projectRoot,
        env: execOptions.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (d) => process.stdout.write(`[${svc.name}] ${d}`));
      child.stderr.on("data", (d) => process.stderr.write(`[${svc.name}] ${d}`));
      child.on("exit", (code) => console.log(`[${svc.name}] process exited (code=${code})`));

      activeWorkers.push(child);
    } catch (err) {
      console.error(`[Electron] Failed to start ${svc.name}:`, err.message);
    }
  }
}

function stopWorkers() {
  for (const child of activeWorkers) {
    try { if (!child.killed) child.kill("SIGTERM"); } catch {}
  }
  activeWorkers = [];
}

// ---------------------------------------------------------------------------
// Wait for the HTTP server to become healthy (max 15 s)
// ---------------------------------------------------------------------------
async function waitForServer(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch("http://127.0.0.1:3001/health");
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Browser Window
// ---------------------------------------------------------------------------
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 840,
    minHeight: 600,
    title: "CodexMemory Control Center",
    backgroundColor: "#ffffff",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  try {
    await mainWindow.loadURL("http://127.0.0.1:3001/");
  } catch (err) {
    console.error("[Electron] Could not load Control Center URL:", err.message);
    // Show a friendly inline error page rather than a blank crash
    await mainWindow.loadURL(
      `data:text/html,<html><body style='font-family:monospace;padding:40px;background:#fff'><h2>CodexMemory</h2><p>Server not reachable at <code>http://127.0.0.1:3001/</code></p><p>Check that the server process started correctly. You can retry by pressing <strong>Cmd+R</strong>.</p></body></html>`
    );
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
ipcMain.handle("engine:start", async () => {
  return new Promise((res) => {
    exec("docker compose up -d redis prometheus grafana", execOptions, (err, stdout, stderr) => {
      if (err) return res({ success: false, error: err.message || stderr });
      startWorkers();
      res({ success: true, message: "Full engine started (Docker + workers)", output: stdout });
    });
  });
});

ipcMain.handle("engine:stop", async () => {
  return new Promise((res) => {
    stopWorkers();
    exec("docker compose stop redis prometheus grafana", execOptions, (err, stdout, stderr) => {
      if (err) return res({ success: false, error: err.message || stderr });
      res({ success: true, message: "Full engine stopped", output: stdout });
    });
  });
});

ipcMain.handle("engine:status", async () => {
  return new Promise((res) => {
    exec("docker compose ps redis --format json", execOptions, (err, stdout) => {
      if (err) return res({ running: false, error: err.message });
      const running = stdout.includes('"State":"running"') || stdout.includes('"running"');
      res({ running, workersActive: activeWorkers.length > 0, raw: stdout });
    });
  });
});

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // 1. Check if server is already running; if not, fork it via utilityProcess
  const alreadyUp = await fetch("http://127.0.0.1:3001/health").then(
    (r) => r.ok,
    () => false
  );

  if (!alreadyUp) {
    startServer();
    const ready = await waitForServer(15000);
    if (!ready) {
      console.error("[Electron] WARNING: Server did not become healthy in 15 s, opening UI anyway.");
    }
  }

  // 2. Auto-start BullMQ workers if Docker Redis is already running
  exec("docker compose ps redis --format json", execOptions, (_err, stdout) => {
    if (stdout && (stdout.includes('"State":"running"') || stdout.includes('"running"'))) {
      startWorkers();
    }
  });

  // 3. Open Control Center desktop window
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function cleanup() {
  stopWorkers();
  stopServer();
}

app.on("before-quit", cleanup);

app.on("window-all-closed", () => {
  cleanup();
  if (process.platform !== "darwin") app.quit();
});
