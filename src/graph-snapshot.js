/**
 * Graph Snapshot — a lightweight JSON cache that decouples the HTTP server
 * from KùzuDB's native addon.
 *
 * The ingestion worker writes a snapshot after each document is processed.
 * The HTTP server reads this snapshot for /api/graph/* responses and for
 * augmenting search results — no direct KùzuDB calls in the server process.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, "../data/graph-snapshot.json");
const SNAPSHOT_DIR = dirname(SNAPSHOT_PATH);

const EMPTY_SNAPSHOT = {
  entities: [],
  relations: [],
  entityTypes: {},
  totalEntities: 0,
  totalRelations: 0,
  updatedAt: null,
};

/**
 * Reads the current graph snapshot from disk.
 * Returns an empty snapshot if none exists.
 */
export async function readSnapshot() {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return { ...EMPTY_SNAPSHOT };
    const raw = await readFile(SNAPSHOT_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { ...EMPTY_SNAPSHOT };
  }
}

/**
 * Writes the graph snapshot to disk.
 * Called by the ingestion worker after processing each document.
 */
export async function writeSnapshot(snapshot) {
  try {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch (err) {
    console.warn("[graph-snapshot] Failed to write snapshot:", err.message);
  }
}

/**
 * Appends/merges new entities and relations into the snapshot, then saves it.
 * Used by the worker after each document ingest.
 */
export async function mergeIntoSnapshot({ entities = [], relations = [], sourceFile = null }) {
  const snapshot = await readSnapshot();

  // Remove existing entries for this source file
  if (sourceFile) {
    snapshot.entities = snapshot.entities.filter((e) => e.sourceFile !== sourceFile);
    snapshot.relations = snapshot.relations.filter(
      (r) => r.fromSource !== sourceFile && r.toSource !== sourceFile
    );
  }

  // Merge new entries
  snapshot.entities.push(...entities);
  snapshot.relations.push(...relations);

  // Rebuild stats
  snapshot.totalEntities = snapshot.entities.length;
  snapshot.totalRelations = snapshot.relations.length;
  snapshot.entityTypes = {};
  for (const e of snapshot.entities) {
    snapshot.entityTypes[e.type] = (snapshot.entityTypes[e.type] || 0) + 1;
  }
  snapshot.updatedAt = new Date().toISOString();

  await writeSnapshot(snapshot);
  return snapshot;
}

/**
 * Removes all graph data associated with a source file from the snapshot.
 */
export async function removeFromSnapshot(sourceFile) {
  const snapshot = await readSnapshot();
  snapshot.entities = snapshot.entities.filter((e) => e.sourceFile !== sourceFile);
  snapshot.relations = snapshot.relations.filter(
    (r) => r.fromSource !== sourceFile && r.toSource !== sourceFile
  );
  snapshot.totalEntities = snapshot.entities.length;
  snapshot.totalRelations = snapshot.relations.length;
  snapshot.entityTypes = {};
  for (const e of snapshot.entities) {
    snapshot.entityTypes[e.type] = (snapshot.entityTypes[e.type] || 0) + 1;
  }
  snapshot.updatedAt = new Date().toISOString();
  await writeSnapshot(snapshot);
}

/**
 * Fast in-memory keyword search over the snapshot's relation triples.
 * Used by search.js as a replacement for live KùzuDB graph traversal.
 */
export async function findConnectedSubgraphFromSnapshot(keywords = []) {
  if (!keywords.length) return [];
  const snapshot = await readSnapshot();
  if (!snapshot.relations.length) return [];

  const results = [];
  const seen = new Set();

  for (const rel of snapshot.relations) {
    const fromName = (rel.fromName || "").toLowerCase();
    const toName = (rel.toName || "").toLowerCase();

    for (const kw of keywords) {
      if (kw.length < 2) continue;
      if (fromName.includes(kw) || toName.includes(kw)) {
        const key = `${rel.fromName}|${rel.relation}|${rel.toName}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            from: { name: rel.fromName, type: rel.fromType },
            relation: rel.relation,
            to: { name: rel.toName, type: rel.toType },
            formatted: `(${rel.fromName}:${rel.fromType}) -[:${rel.relation}]-> (${rel.toName}:${rel.toType})`,
          });
        }
        break;
      }
    }

    if (results.length >= 30) break;
  }

  return results;
}
