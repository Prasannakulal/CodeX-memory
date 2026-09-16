/**
 * graph.js — Unified, Zero-Crash In-Memory Knowledge Graph Engine
 *
 * Replaces KùzuDB C++ native addon with a pure JavaScript graph engine
 * backed by persistent JSON storage. Provides:
 * - Multi-hop BFS traversal for GraphRAG
 * - Graph statistics & entity/relation management
 * - 100% stable in Electron with zero native crash risk
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAPH_FILE = join(__dirname, "../data/graph-snapshot.json");
const GRAPH_DIR = dirname(GRAPH_FILE);

const EMPTY_GRAPH = {
  entities: [],
  relations: [],
  entityTypes: {},
  totalEntities: 0,
  totalRelations: 0,
  updatedAt: null,
};

let cachedGraph = null;

/**
 * Loads graph from disk or cache.
 */
export async function readGraph() {
  if (cachedGraph) return cachedGraph;

  try {
    if (!existsSync(GRAPH_FILE)) {
      cachedGraph = { ...EMPTY_GRAPH };
      return cachedGraph;
    }
    const raw = await readFile(GRAPH_FILE, "utf-8");
    cachedGraph = JSON.parse(raw);
    return cachedGraph;
  } catch {
    cachedGraph = { ...EMPTY_GRAPH };
    return cachedGraph;
  }
}

/**
 * Persists graph state to disk.
 */
export async function writeGraph(graph) {
  try {
    cachedGraph = graph;
    await mkdir(GRAPH_DIR, { recursive: true });
    await writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2), "utf-8");
  } catch (err) {
    console.warn("[graph] Failed to write graph state:", err.message);
  }
}

/**
 * Merges extracted entities and relations into the knowledge graph.
 */
export async function mergeIntoGraph({ entities = [], relations = [], sourceFile = null }) {
  const graph = await readGraph();

  // Remove existing entries for this source file to support clean re-indexing
  if (sourceFile) {
    graph.entities = (graph.entities || []).filter((e) => e.sourceFile !== sourceFile);
    graph.relations = (graph.relations || []).filter(
      (r) => r.fromSource !== sourceFile && r.toSource !== sourceFile
    );
  }

  // Deduplicate entities by ID or name
  const existingIds = new Set(graph.entities.map((e) => e.id || e.name.toLowerCase()));
  for (const entity of entities) {
    const key = entity.id || entity.name.toLowerCase();
    if (!existingIds.has(key)) {
      existingIds.add(key);
      graph.entities.push(entity);
    }
  }

  // Deduplicate relations
  const existingRels = new Set(
    graph.relations.map((r) => `${r.fromName || r.fromId}|${r.relation}|${r.toName || r.toId}`)
  );
  for (const rel of relations) {
    const key = `${rel.fromName || rel.fromId}|${rel.relation}|${rel.toName || rel.toId}`;
    if (!existingRels.has(key)) {
      existingRels.add(key);
      graph.relations.push(rel);
    }
  }

  // Recompute metadata and stats
  graph.totalEntities = graph.entities.length;
  graph.totalRelations = graph.relations.length;
  graph.entityTypes = {};
  for (const e of graph.entities) {
    const t = e.type || "Concept";
    graph.entityTypes[t] = (graph.entityTypes[t] || 0) + 1;
  }
  graph.updatedAt = new Date().toISOString();

  await writeGraph(graph);
  return graph;
}

/**
 * Removes all entities and relations associated with a sourceFile.
 */
export async function removeFromGraph(sourceFile) {
  if (!sourceFile) return;
  const graph = await readGraph();
  graph.entities = (graph.entities || []).filter((e) => e.sourceFile !== sourceFile);
  graph.relations = (graph.relations || []).filter(
    (r) => r.fromSource !== sourceFile && r.toSource !== sourceFile
  );
  graph.totalEntities = graph.entities.length;
  graph.totalRelations = graph.relations.length;
  graph.entityTypes = {};
  for (const e of graph.entities) {
    const t = e.type || "Concept";
    graph.entityTypes[t] = (graph.entityTypes[t] || 0) + 1;
  }
  graph.updatedAt = new Date().toISOString();
  await writeGraph(graph);
  return graph;
}

/**
 * Multi-hop Graph Traversal (BFS)
 * Discovers connected entities up to maxHops away for given query keywords.
 */
export async function findConnectedSubgraph(keywords = [], maxHops = 2, limit = 25) {
  if (!keywords || !keywords.length) return [];
  const graph = await readGraph();
  if (!graph.relations || !graph.relations.length) return [];

  const matchedEntities = new Set();
  const searchTokens = keywords
    .map((k) => k.toLowerCase().trim())
    .filter((k) => k.length >= 2);

  // 1. Identify seed nodes matching keywords
  for (const entity of graph.entities || []) {
    const nameLower = (entity.name || "").toLowerCase();
    for (const token of searchTokens) {
      if (nameLower.includes(token)) {
        matchedEntities.add(entity.name);
        break;
      }
    }
  }

  // Also check relation endpoint names directly
  for (const rel of graph.relations) {
    const from = (rel.fromName || "").toLowerCase();
    const to = (rel.toName || "").toLowerCase();
    for (const token of searchTokens) {
      if (from.includes(token)) matchedEntities.add(rel.fromName);
      if (to.includes(token)) matchedEntities.add(rel.toName);
    }
  }

  if (matchedEntities.size === 0) return [];

  // 2. Perform BFS exploration across relations
  const results = [];
  const visitedEdges = new Set();
  let currentFrontier = new Set(matchedEntities);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set();

    for (const rel of graph.relations) {
      const fromName = rel.fromName || rel.fromId;
      const toName = rel.toName || rel.toId;
      const edgeKey = `${fromName}|${rel.relation}|${toName}`;

      if (visitedEdges.has(edgeKey)) continue;

      if (currentFrontier.has(fromName) || currentFrontier.has(toName)) {
        visitedEdges.add(edgeKey);
        nextFrontier.add(fromName);
        nextFrontier.add(toName);

        results.push({
          from: { name: fromName, type: rel.fromType || "Concept" },
          relation: rel.relation,
          to: { name: toName, type: rel.toType || "Concept" },
          formatted: `(${fromName}:${rel.fromType || "Concept"}) -[:${rel.relation}]-> (${toName}:${rel.toType || "Concept"})`,
        });

        if (results.length >= limit) break;
      }
    }

    if (results.length >= limit || nextFrontier.size === 0) break;
    currentFrontier = nextFrontier;
  }

  return results;
}

/**
 * Returns summary stats for the Control Center UI
 */
export async function getGraphStats() {
  const graph = await readGraph();
  return {
    totalEntities: graph.totalEntities || 0,
    totalRelations: graph.totalRelations || 0,
    entityTypes: graph.entityTypes || {},
    updatedAt: graph.updatedAt || null,
    available: (graph.totalEntities || 0) > 0,
    source: "in-memory",
  };
}

/**
 * Returns entity list for UI
 */
export async function getEntities(limit = 200) {
  const graph = await readGraph();
  return (graph.entities || []).slice(0, limit);
}

/**
 * Returns relation list for UI / Graph Visualizer
 */
export async function getRelations(limit = 1000) {
  const graph = await readGraph();
  return (graph.relations || []).slice(0, limit);
}
