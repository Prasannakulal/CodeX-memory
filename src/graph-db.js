import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import config from "./config.js";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// KùzuDB is a native addon that ships prebuilt binaries per platform+arch.
// On Apple Silicon Macs, Electron runs as arm64 but the system node may run
// as x64 (Rosetta). We load kuzu lazily so that if the prebuilt doesn't match
// the current process architecture, we degrade gracefully instead of crashing.
// ---------------------------------------------------------------------------
let kuzu = null;
let kuzuLoadError = null;

async function loadKuzu() {
  if (kuzu !== null) return kuzu;
  if (kuzuLoadError) return null;
  try {
    const mod = await import("kuzu");
    kuzu = mod.default ?? mod;
    return kuzu;
  } catch (err) {
    kuzuLoadError = err;
    logger.warn(
      { error: err.message, arch: process.arch, platform: process.platform },
      "[GraphRAG] KùzuDB native addon could not be loaded — graph features disabled"
    );
    return null;
  }
}

export function isKuzuAvailable() {
  return kuzu !== null && kuzuLoadError === null;
}

let dbInstance = null;
let connectionInstance = null;
let isInitialized = false;

function escapeCypherString(str) {
  if (typeof str !== "string") return "";
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Gets or initializes the singleton Kùzu Database connection.
 * Returns null if KùzuDB is not available on this platform/arch.
 */
export async function getGraphConnection(customPath = null) {
  if (connectionInstance) return connectionInstance;

  const k = await loadKuzu();
  if (!k) return null;

  const dbPath = customPath || resolve(process.cwd(), config.graphDatabase?.path || "./data/kuzudb");
  mkdirSync(dirname(dbPath), { recursive: true });

  dbInstance = new k.Database(dbPath);
  connectionInstance = new k.Connection(dbInstance);

  if (!isInitialized) {
    await initSchema(connectionInstance);
    isInitialized = true;
  }

  return connectionInstance;
}

/**
 * Initializes Kùzu property graph schema if not already present.
 */
export async function initSchema(conn) {
  const schemaStatements = [
    `CREATE NODE TABLE IF NOT EXISTS Entity(
      id STRING,
      name STRING,
      type STRING,
      sourceFile STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Document(
      filePath STRING,
      title STRING,
      PRIMARY KEY (filePath)
    )`,
    `CREATE REL TABLE IF NOT EXISTS RELATES_TO(
      FROM Entity TO Entity,
      relation STRING
    )`,
    `CREATE REL TABLE IF NOT EXISTS MENTIONED_IN(
      FROM Entity TO Document
    )`
  ];

  for (const statement of schemaStatements) {
    try {
      await conn.query(statement);
    } catch (err) {
      if (!err.message?.includes("already exists")) {
        logger.warn({ error: err.message, statement }, "Kuzu schema statement note");
      }
    }
  }
}

/**
 * Upserts a knowledge graph entity node.
 */
export async function upsertEntity(entity, conn = null) {
  const connection = conn || (await getGraphConnection());
  if (!connection) return null;

  const { id, name, type = "Concept", sourceFile = "" } = entity;
  const cleanId = escapeCypherString(id.toLowerCase().trim());
  const cleanName = escapeCypherString(name.trim());
  const cleanType = escapeCypherString(type.trim());
  const cleanSource = escapeCypherString(sourceFile);

  const query = `
    MERGE (e:Entity {id: '${cleanId}'})
    ON CREATE SET e.name = '${cleanName}', e.type = '${cleanType}', e.sourceFile = '${cleanSource}'
    ON MATCH SET e.name = '${cleanName}', e.type = '${cleanType}', e.sourceFile = '${cleanSource}'
  `;

  await connection.query(query);
  return { id: cleanId, name, type, sourceFile };
}

/**
 * Creates a directed relationship between two entities.
 */
export async function addRelation(fromId, toId, relation = "RELATES_TO", conn = null) {
  const connection = conn || (await getGraphConnection());
  if (!connection) return false;

  const cFrom = escapeCypherString(fromId.toLowerCase().trim());
  const cTo = escapeCypherString(toId.toLowerCase().trim());
  const cRel = escapeCypherString(relation.toUpperCase().replace(/\s+/g, "_"));

  if (cFrom === cTo) return false;

  const checkQuery = `
    MATCH (a:Entity {id: '${cFrom}'})-[r:RELATES_TO {relation: '${cRel}'}]->(b:Entity {id: '${cTo}'})
    RETURN count(r) AS relCount
  `;
  const res = await connection.query(checkQuery);
  const rows = await res.getAll();
  const count = rows[0]?.relCount ?? rows[0]?.["count(r)"] ?? 0;

  if (Number(count) === 0) {
    const createQuery = `
      MATCH (a:Entity {id: '${cFrom}'}), (b:Entity {id: '${cTo}'})
      CREATE (a)-[:RELATES_TO {relation: '${cRel}'}]->(b)
    `;
    await connection.query(createQuery);
    return true;
  }

  return false;
}

/**
 * Deletes all entities and edges originating from a specific source file.
 */
export async function deleteDocumentGraph(filePath, conn = null) {
  const connection = conn || (await getGraphConnection());
  if (!connection) return;

  const cleanPath = escapeCypherString(filePath);
  try {
    await connection.query(`
      MATCH (e:Entity {sourceFile: '${cleanPath}'})
      DETACH DELETE e
    `);
  } catch (err) {
    logger.warn({ error: err.message, filePath }, "Failed to delete document entities from Kuzu");
  }
}

/**
 * Traverses the graph to find connected subgraphs for given query keywords/entity names.
 * Returns an empty array if KùzuDB is not available.
 */
export async function findConnectedSubgraph(entityNames = [], depth = 2, conn = null) {
  if (!Array.isArray(entityNames) || entityNames.length === 0) return [];

  const connection = conn || (await getGraphConnection());
  if (!connection) return [];

  const results = [];
  const seenTriples = new Set();

  for (const name of entityNames) {
    const cleanName = escapeCypherString(name.toLowerCase().trim());
    if (!cleanName || cleanName.length < 2) continue;

    const query = `
      MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
      WHERE lower(a.name) CONTAINS '${cleanName}' OR lower(b.name) CONTAINS '${cleanName}'
         OR lower(a.id) CONTAINS '${cleanName}' OR lower(b.id) CONTAINS '${cleanName}'
      RETURN a.name AS fromName, a.type AS fromType, r.relation AS relation, b.name AS toName, b.type AS toType
      LIMIT 25
    `;

    try {
      const res = await connection.query(query);
      const rows = await res.getAll();

      for (const row of rows) {
        const fromName = row.fromName ?? row["a.name"] ?? "";
        const fromType = row.fromType ?? row["a.type"] ?? "Entity";
        const relation = row.relation ?? row["r.relation"] ?? "RELATES_TO";
        const toName = row.toName ?? row["b.name"] ?? "";
        const toType = row.toType ?? row["b.type"] ?? "Entity";

        const key = `${fromName}|${relation}|${toName}`;
        if (!seenTriples.has(key)) {
          seenTriples.add(key);
          results.push({
            from: { name: fromName, type: fromType },
            relation,
            to: { name: toName, type: toType },
            formatted: `(${fromName}:${fromType}) -[:${relation}]-> (${toName}:${toType})`
          });
        }
      }
    } catch (err) {
      logger.error({ error: err.message, name }, "Error executing graph traversal query");
    }
  }

  return results;
}

/**
 * Retrieves overall graph database stats.
 * Returns zeros if KùzuDB is not available.
 */
export async function getGraphStats(conn = null) {
  const connection = conn || (await getGraphConnection());
  if (!connection) {
    return { totalEntities: 0, totalRelations: 0, entityTypes: {}, available: false };
  }

  let totalEntities = 0;
  let totalRelations = 0;
  const entityTypes = {};

  try {
    const eRes = await connection.query("MATCH (e:Entity) RETURN count(e) AS entityCount");
    const eRows = await eRes.getAll();
    totalEntities = Number(eRows[0]?.entityCount ?? eRows[0]?.["count(e)"] ?? 0);

    const rRes = await connection.query("MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS relCount");
    const rRows = await rRes.getAll();
    totalRelations = Number(rRows[0]?.relCount ?? rRows[0]?.["count(r)"] ?? 0);

    const tRes = await connection.query("MATCH (e:Entity) RETURN e.type AS type, count(e) AS count");
    const tRows = await tRes.getAll();
    for (const r of tRows) {
      const type = r.type ?? r["e.type"] ?? "Other";
      const count = Number(r.count ?? r["count(e)"] ?? 0);
      entityTypes[type] = count;
    }
  } catch (err) {
    logger.warn({ error: err.message }, "Error fetching graph stats");
  }

  return { totalEntities, totalRelations, entityTypes, available: true };
}

/**
 * Returns all entities for UI display.
 * Returns empty array if KùzuDB is not available.
 */
export async function getAllEntities(limit = 100, conn = null) {
  const connection = conn || (await getGraphConnection());
  if (!connection) return [];

  const query = `
    MATCH (e:Entity)
    RETURN e.id AS id, e.name AS name, e.type AS type, e.sourceFile AS sourceFile
    LIMIT ${Number(limit) || 100}
  `;

  try {
    const res = await connection.query(query);
    const rows = await res.getAll();
    return rows.map((r) => ({
      id: r.id ?? r["e.id"],
      name: r.name ?? r["e.name"],
      type: r.type ?? r["e.type"],
      sourceFile: r.sourceFile ?? r["e.sourceFile"],
    }));
  } catch {
    return [];
  }
}

/**
 * Closes the Kùzu database connection cleanly.
 */
export async function closeGraph() {
  if (connectionInstance) {
    try {
      connectionInstance = null;
      dbInstance = null;
      isInitialized = false;
    } catch {}
  }
}
