/**
 * graph-service.js — KùzuDB Graph Query Microservice
 *
 * Runs as a standalone system-node process (NOT inside Electron's
 * utilityProcess). This isolates KùzuDB's native async workers from
 * Electron's libuv thread pool, which previously caused SIGSEGV crashes.
 *
 * The HTTP/MCP server talks to this service over http://127.0.0.1:3002.
 *
 * Endpoints:
 *   GET  /health          → { ok: true, entities, relations }
 *   POST /query           → multi-hop Cypher traversal
 *   GET  /stats           → entity/relation counts by type
 */

import http from "node:http";
import { mergeIntoSnapshot, readSnapshot } from "./graph-snapshot.js";

const PORT = Number(process.env.GRAPH_SERVICE_PORT || 3002);

// ---------------------------------------------------------------------------
// KùzuDB connection (lazy, with graceful degradation)
// ---------------------------------------------------------------------------
let _db = null;
let _conn = null;
let _kuzuAvailable = false;

async function getConnection() {
  if (_conn) return _conn;
  try {
    const kuzu = await import("kuzu");
    _db   = new kuzu.Database("./data/graph.db");
    _conn = new kuzu.Connection(_db);

    // Ensure schema exists
    await _conn.query(`
      CREATE NODE TABLE IF NOT EXISTS Entity (
        id STRING,
        name STRING,
        type STRING,
        sourceFile STRING,
        PRIMARY KEY (id)
      )
    `);
    await _conn.query(`
      CREATE REL TABLE IF NOT EXISTS RELATES (
        FROM Entity TO Entity,
        relation STRING,
        PRIMARY KEY ()
      )
    `);

    _kuzuAvailable = true;
    console.log("[graph-service] KùzuDB connected on", "./data/graph.db");
    return _conn;
  } catch (err) {
    console.warn("[graph-service] KùzuDB unavailable, will use snapshot fallback:", err.message);
    _kuzuAvailable = false;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multi-hop Cypher traversal
// ---------------------------------------------------------------------------
async function queryGraph({ keywords = [], hops = 2, limit = 20 } = {}) {
  if (!keywords.length) return [];

  const conn = await getConnection();

  // Fallback: keyword search over JSON snapshot
  if (!conn) {
    const { findConnectedSubgraphFromSnapshot } = await import("./graph-snapshot.js");
    return findConnectedSubgraphFromSnapshot(keywords);
  }

  // Build a UNION of per-keyword Cypher queries
  // e.g. MATCH (a:Entity)-[r:RELATES*1..2]-(b:Entity) WHERE a.name CONTAINS 'redis'
  const results = [];
  const seen = new Set();

  for (const kw of keywords.slice(0, 5)) {
    if (kw.length < 2) continue;
    try {
      const hopPattern = hops === 1 ? "[r:RELATES]" : `[r:RELATES*1..${hops}]`;
      const cypher = `
        MATCH (a:Entity)-${hopPattern}-(b:Entity)
        WHERE LOWER(a.name) CONTAINS LOWER('${kw.replace(/'/g, "\\'")}')
           OR LOWER(b.name) CONTAINS LOWER('${kw.replace(/'/g, "\\'")}')
        RETURN a.name AS fromName, a.type AS fromType,
               r.relation AS relation,
               b.name AS toName, b.type AS toType
        LIMIT ${limit}
      `;
      const res = await conn.query(cypher);
      const table = await res.getAll();
      for (const row of table) {
        const key = `${row.fromName}|${row.relation}|${row.toName}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            from:      { name: row.fromName, type: row.fromType },
            relation:  row.relation || "RELATES",
            to:        { name: row.toName,   type: row.toType },
            formatted: `(${row.fromName}:${row.fromType}) -[:${row.relation || "RELATES"}]-> (${row.toName}:${row.toType})`,
          });
        }
      }
    } catch (err) {
      console.warn(`[graph-service] Cypher error for keyword "${kw}":`, err.message);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stats from KùzuDB or snapshot
// ---------------------------------------------------------------------------
async function getStats() {
  const conn = await getConnection();
  if (!conn) {
    const snap = await readSnapshot();
    return {
      source: "snapshot",
      totalEntities: snap.totalEntities || 0,
      totalRelations: snap.totalRelations || 0,
      entityTypes: snap.entityTypes || {},
      kuzuAvailable: false,
    };
  }

  try {
    const eRes = await (await conn.query("MATCH (e:Entity) RETURN e.type AS type, COUNT(*) AS cnt")).getAll();
    const rRes = await (await conn.query("MATCH ()-[r:RELATES]-() RETURN COUNT(r) AS cnt")).getAll();

    const entityTypes = {};
    let totalEntities = 0;
    for (const row of eRes) {
      entityTypes[row.type] = Number(row.cnt);
      totalEntities += Number(row.cnt);
    }

    return {
      source: "kuzudb",
      totalEntities,
      totalRelations: Number(rRes[0]?.cnt || 0),
      entityTypes,
      kuzuAvailable: true,
    };
  } catch (err) {
    const snap = await readSnapshot();
    return {
      source: "snapshot-fallback",
      totalEntities: snap.totalEntities || 0,
      totalRelations: snap.totalRelations || 0,
      entityTypes: snap.entityTypes || {},
      kuzuAvailable: false,
      error: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// JSON body parser (no express, keep it tiny)
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    // GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      const snap = await readSnapshot();
      send(res, 200, {
        ok: true,
        kuzuAvailable: _kuzuAvailable,
        snapshotEntities: snap.totalEntities || 0,
        snapshotRelations: snap.totalRelations || 0,
      });
      return;
    }

    // POST /query  { keywords: string[], hops?: number, limit?: number }
    if (req.method === "POST" && url.pathname === "/query") {
      const body    = await parseBody(req);
      const keywords = (body.keywords || []).map((k) => String(k).trim()).filter(Boolean);
      const hops    = Math.min(Number(body.hops  || 2), 3);
      const limit   = Math.min(Number(body.limit || 25), 100);

      if (!keywords.length) { send(res, 400, { error: "keywords required" }); return; }

      const results = await queryGraph({ keywords, hops, limit });
      send(res, 200, { results, source: _kuzuAvailable ? "kuzudb" : "snapshot", count: results.length });
      return;
    }

    // GET /stats
    if (req.method === "GET" && url.pathname === "/stats") {
      const stats = await getStats();
      send(res, 200, stats);
      return;
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[graph-service] Request error:", err.message);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[graph-service] Graph query service listening on http://127.0.0.1:${PORT}`);
  // Warm up the KùzuDB connection immediately
  await getConnection();
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`[graph-service] Received ${signal}; shutting down`);
  server.close(() => {
    if (_db) { try { _db.close(); } catch {} }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
