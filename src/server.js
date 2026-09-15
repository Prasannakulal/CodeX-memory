import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { readdir, stat, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import express from "express";
import { z } from "zod";
import { config } from "./config.js";
import { searchDocuments } from "./search.js";
import { queueDocument, ingestionQueue, connection } from "./queue.js";
import { deleteDocument } from "./delete-document.js";
import db from "./database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export let isEngineActive = true;
export function setEngineActive(active) {
  isEngineActive = Boolean(active);
}

/**
 * Creates and registers tools on an McpServer instance.
 */
export function createMcpServer() {
  const server = new McpServer({
    name: "codex-memory",
    version: "1.0.0",
  });

  server.tool(
    "search_documents",
    "Searches local documents using semantic similarity",
    {
      query: z.string().min(1),
      topK: z.number().int().min(1).max(10).default(5),
    },
    async ({ query, topK }) => {
      try {
        const results = await searchDocuments(query, topK);

        let text = results
          .map((result, index) => {
            return [
              `--- Result ${index + 1} ---`,
              `Text: ${result.text}`,
              `Source: ${result.sourceFile}`,
              `Distance: ${result._distance}`,
              `Score: ${result.score !== undefined ? `${Math.round(result.score * 100)}%` : "—"} (${result.matchType || "semantic"})`,
            ].join("\n");
          })
          .join("\n\n");

        if (results.graphContext && results.graphContext.length > 0) {
          const graphSummary = results.graphContext.map((g) => `• ${g.formatted}`).join("\n");
          text = `=== Knowledge Graph Facts (GraphRAG) ===\n${graphSummary}\n\n=== Document Chunks ===\n${text}`;
        }

        return {
          content: [
            {
              type: "text",
              text: text || "No matching documents found.",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Search error: ${error.message || "Failed to search documents"}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

/**
 * Creates the Express application configured with Streamable HTTP MCP handlers and Control Center API.
 */
export function createMcpApp(options = {}) {
  const host = options.host || config.mcp.host;
  const authToken = options.authToken !== undefined ? options.authToken : config.mcp.authToken;

  // createMcpExpressApp configures express.json() and localhost DNS rebinding protection
  const app = createMcpExpressApp({ host });
  const transports = new Map();

  // Serve static UI assets from public/
  app.use(express.static(join(__dirname, "../public")));

  // Root endpoint serves the Control Center Dashboard
  app.get("/", (_req, res) => {
    res.sendFile(join(__dirname, "../public/index.html"));
  });

  // Security warning if binding to non-localhost without authentication
  if ((host === "0.0.0.0" || host === "::") && !authToken) {
    console.warn(
      `[codex-memory] WARNING: Server is binding to ${host} without authentication. ` +
      `Consider setting MCP_AUTH_TOKEN to secure this endpoint.`
    );
  }

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "codex-memory",
      transport: "streamable-http",
      endpoint: "/mcp",
      activeSessions: transports.size,
    });
  });

  // Handle Chrome DevTools internal probing cleanly without 404s
  app.use("/.well-known", (_req, res) => {
    res.status(204).end();
  });

  // =========================================================================
  // Control Center REST APIs
  // =========================================================================

  // GET /api/status: System health, Redis, Ollama, LanceDB, and MCP status
  app.get("/api/status", async (_req, res) => {
    let redisStatus = "disconnected";
    let queueCounts = { waiting: 0, active: 0, completed: 0, failed: 0 };
    try {
      const redisConn = connection || ingestionQueue?.opts?.connection;
      if (redisConn && redisConn.status === "ready") {
        queueCounts = await Promise.race([
          ingestionQueue.getJobCounts(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 600)),
        ]);
        redisStatus = "connected";
      }
    } catch {
      redisStatus = "disconnected";
    }

    let ollamaStatus = "error";
    try {
      const ollamaRes = await fetch(`${config.ollama.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (ollamaRes.ok) ollamaStatus = "connected";
    } catch {
      ollamaStatus = "disconnected";
    }

    let dbStatus = "ready";
    let totalChunks = 0;
    try {
      const tables = await db.tableNames();
      if (tables.includes("documents")) {
        const table = await db.openTable("documents");
        totalChunks = await table.countRows();
      }
    } catch {
      dbStatus = "error";
    }

    res.json({
      status: "online",
      engine: {
        status: isEngineActive ? "running" : "stopped",
        running: isEngineActive,
      },
      redis: { status: isEngineActive ? redisStatus : "disconnected" },
      ollama: { status: ollamaStatus, model: config.ollama.model },
      queue: queueCounts,
      database: { status: dbStatus, totalChunks },
      mcp: {
        endpoint: "/mcp",
        port: config.mcp.port,
        activeSessions: transports.size,
      },
    });
  });

  // GET /api/documents: List all documents in docs/ directory
  app.get("/api/documents", async (_req, res) => {
    try {
      if (!existsSync(config.docs.dir)) {
        return res.json([]);
      }
      const files = await readdir(config.docs.dir);
      const docFiles = files.filter(
        (f) => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".markdown")
      );

      let table = null;
      try {
        const tables = await db.tableNames();
        if (tables.includes("documents")) {
          table = await db.openTable("documents");
        }
      } catch {}

      const docsList = await Promise.all(
        docFiles.map(async (name) => {
          const fullPath = join(config.docs.dir, name);
          const st = await stat(fullPath);
          let chunks = 0;
          if (table) {
            try {
              chunks = await table.countRows(
                `\`sourceFile\` = '${fullPath.replaceAll("'", "''")}'`
              );
            } catch {}
          }
          return {
            name,
            path: fullPath,
            size: st.size,
            modifiedAt: st.mtime,
            chunks,
          };
        })
      );

      res.json(docsList);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/documents/note: Create and queue a quick markdown note
  app.post("/api/documents/note", async (req, res) => {
    try {
      const { title, content } = req.body || {};
      if (!title || !content) {
        return res.status(400).json({ error: "Title and content are required" });
      }

      const cleanTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "untitled";

      const filename = `${cleanTitle}.md`;
      const filePath = join(config.docs.dir, filename);

      await writeFile(filePath, content, "utf-8");
      await queueDocument(filePath);

      res.json({
        success: true,
        filename,
        message: "Note saved and queued for vector indexing",
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/documents/upload: Upload a file directly from browser
  app.post("/api/documents/upload", async (req, res) => {
    try {
      const { name, content } = req.body || {};
      if (!name || content === undefined) {
        return res.status(400).json({ error: "Filename and content are required" });
      }

      const cleanName = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(config.docs.dir, cleanName);

      await writeFile(filePath, content, "utf-8");
      await queueDocument(filePath);

      res.json({
        success: true,
        filename: cleanName,
        message: "File uploaded and queued for vector indexing",
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/documents/:filename: Delete document and purge vector chunks
  app.delete("/api/documents/:filename", async (req, res) => {
    try {
      const filename = basename(req.params.filename);
      const filePath = join(config.docs.dir, filename);

      if (existsSync(filePath)) {
        await unlink(filePath);
      }
      await deleteDocument(filePath);

      res.json({ success: true, message: `Deleted ${filename}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/search: Run vector search and return structured results
  app.post("/api/search", async (req, res) => {
    try {
      const { query, topK = 5 } = req.body || {};
      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Query string is required" });
      }

      const k = Math.min(Math.max(Number(topK) || 5, 1), 10);
      const results = await searchDocuments(query, k);

      res.json({
        success: true,
        results,
        graphContext: results.graphContext || [],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/graph/stats: Knowledge Graph statistics (from JSON snapshot)
  app.get("/api/graph/stats", async (_req, res) => {
    try {
      const { readSnapshot } = await import("./graph-snapshot.js");
      const snapshot = await readSnapshot();
      res.json({
        totalEntities: snapshot.totalEntities || 0,
        totalRelations: snapshot.totalRelations || 0,
        entityTypes: snapshot.entityTypes || {},
        updatedAt: snapshot.updatedAt || null,
        available: snapshot.totalEntities > 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/graph/entities: Knowledge Graph entity list (from JSON snapshot)
  app.get("/api/graph/entities", async (req, res) => {
    try {
      const { readSnapshot } = await import("./graph-snapshot.js");
      const limit = Number(req.query.limit) || 100;
      const snapshot = await readSnapshot();
      const entities = (snapshot.entities || []).slice(0, limit);
      res.json(entities);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/graph/relations: Knowledge Graph relations list (from JSON snapshot)
  app.get("/api/graph/relations", async (req, res) => {
    try {
      const { readSnapshot } = await import("./graph-snapshot.js");
      const limit = Number(req.query.limit) || 500;
      const snapshot = await readSnapshot();
      const relations = (snapshot.relations || []).slice(0, limit);
      res.json(relations);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/actions/reindex-all: Reindex all documents in docs/ folder
  app.post("/api/actions/reindex-all", async (_req, res) => {
    try {
      if (!existsSync(config.docs.dir)) {
        return res.json({ success: true, queuedCount: 0 });
      }
      const files = await readdir(config.docs.dir);
      const docFiles = files.filter(
        (f) => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".markdown")
      );

      for (const file of docFiles) {
        const fullPath = join(config.docs.dir, file);
        await queueDocument(fullPath);
      }

      res.json({ success: true, queuedCount: docFiles.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const execOptions = {
    cwd: resolve(__dirname, ".."),
    env: {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
    },
  };

  // POST /api/engine/start: Start engine services via Docker Compose
  app.post("/api/engine/start", async (_req, res) => {
    exec("docker compose up -d redis prometheus grafana", execOptions, (err, stdout, stderr) => {
      if (err) {
        const isContainer = existsSync("/.dockerenv");
        const errorMsg = isContainer
          ? "Docker daemon cannot be invoked from inside container. Please use the Desktop app or run docker compose in your terminal."
          : (err.message || stderr);
        return res.status(500).json({ error: errorMsg });
      }
      setEngineActive(true);
      res.json({ success: true, message: "Engine started successfully", output: stdout });
    });
  });

  // POST /api/engine/stop: Stop engine services (pausing queue & background processing)
  app.post("/api/engine/stop", async (_req, res) => {
    exec("docker compose stop redis prometheus grafana", execOptions, (err, stdout, stderr) => {
      if (err) {
        const isContainer = existsSync("/.dockerenv");
        const errorMsg = isContainer
          ? "Docker daemon cannot be invoked from inside container. Please use the Desktop app or run docker compose in your terminal."
          : (err.message || stderr);
        return res.status(500).json({ error: errorMsg });
      }
      setEngineActive(false);
      res.json({ success: true, message: "Engine stopped successfully", output: stdout });
    });
  });

  // =========================================================================
  // MCP Streamable HTTP Route Handlers
  // =========================================================================

  // Optional authentication middleware for /mcp
  if (authToken) {
    app.use("/mcp", (req, res, next) => {
      const authHeader = req.headers["authorization"];
      const apiKeyHeader = req.headers["x-api-key"];
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : apiKeyHeader;

      if (token !== authToken) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Unauthorized: Invalid or missing authentication token",
          },
          id: null,
        });
        return;
      }
      next();
    });
  }

  // POST /mcp: handles JSON-RPC messages and session initialization
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      let transport;

      if (sessionId && transports.has(sessionId)) {
        // Reuse existing transport for this session
        transport = transports.get(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports.has(sid)) {
            transports.delete(sid);
          }
        };

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else if (sessionId && !transports.has(sessionId)) {
        // Invalid session ID
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session not found",
          },
          id: null,
        });
        return;
      } else {
        // Missing session ID and not an initialize request
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Missing valid session ID or not an initialize request",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[codex-memory] Error handling MCP POST request:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  // GET /mcp: handles SSE streaming connections for existing sessions
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Invalid or missing session ID",
        },
        id: null,
      });
      return;
    }

    try {
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[codex-memory] Error handling MCP GET request:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  // DELETE /mcp: handles session termination
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Invalid or missing session ID",
        },
        id: null,
      });
      return;
    }

    try {
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
    } catch (error) {
      console.error("[codex-memory] Error terminating session:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  // Clean error handling middleware (handles JSON parse errors safely)
  app.use((err, _req, res, _next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Parse error: Invalid JSON",
        },
        id: null,
      });
    }

    console.error("[codex-memory] Unhandled server error:", err.message);
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  });

  return { app, transports };
}

/**
 * Starts the MCP server using Streamable HTTP transport.
 */
export function startHttpServer(options = {}) {
  const port = options.port || config.mcp.port;
  const host = options.host || config.mcp.host;
  const { app, transports } = createMcpApp(options);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (err) => {
      if (err) return reject(err);

      console.log(`[codex-memory] Control Center: http://${host}:${port}/`);
      console.log(`[codex-memory] MCP Streamable HTTP Endpoint: http://${host}:${port}/mcp`);

      if (options.authToken || config.mcp.authToken) {
        console.log(`[codex-memory] Authentication: Bearer token enabled`);
      }

      resolve({ server, port, host, transports });
    });
  });
}

/**
 * Starts the MCP server using legacy stdio transport.
 */
export async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

// Auto-start when executed directly
const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  const isStdio =
    process.argv.includes("--stdio") || config.mcp.transport === "stdio";

  if (isStdio) {
    await startStdioServer();
  } else {
    const { server, transports } = await startHttpServer();

    const cleanup = () => {
      console.log("\n[codex-memory] Shutting down MCP server...");
      for (const [sid, transport] of transports.entries()) {
        try {
          transport.close();
        } catch {
          // ignore
        }
      }
      transports.clear();
      server.close(() => {
        process.exit(0);
      });
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }
}