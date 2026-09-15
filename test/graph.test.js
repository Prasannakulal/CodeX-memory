import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractGraphData } from "../src/extractor.js";
import {
  getGraphConnection,
  upsertEntity,
  addRelation,
  findConnectedSubgraph,
  deleteDocumentGraph,
  getGraphStats,
  getAllEntities,
  closeGraph,
} from "../src/graph-db.js";

test("extractGraphData extracts entities and relationships from markdown", () => {
  const markdown = `
# About Me — Prasanna Kulal

## Projects

### CodexMemory
A local RAG MCP server using:
- Node.js
- LanceDB
- Redis
- BullMQ
`;

  const { entities, relations } = extractGraphData(markdown, "/test/prasanna.md");

  assert.ok(entities.length > 0, "Should extract entities");
  assert.ok(relations.length > 0, "Should extract relations");

  const person = entities.find((e) => e.type === "Person");
  assert.ok(person, "Should detect Person entity");
  assert.equal(person.name, "Prasanna Kulal");

  const project = entities.find((e) => e.type === "Project");
  assert.ok(project, "Should detect Project entity");
  assert.equal(project.name, "CodexMemory");

  const tech = entities.filter((e) => e.type === "Technology");
  assert.ok(tech.some((t) => t.name === "LanceDB"), "Should detect LanceDB technology");
  assert.ok(tech.some((t) => t.name === "Redis"), "Should detect Redis technology");
});

test("KùzuDB graph storage, relationship traversal, and cleanup", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "kuzu-test-"));
  const dbPath = join(tempDir, "graphdb");

  t.after(async () => {
    await closeGraph();
    await rm(tempDir, { recursive: true, force: true });
  });

  const conn = await getGraphConnection(dbPath);

  // Upsert entities
  await upsertEntity(
    { id: "prasanna_kulal", name: "Prasanna Kulal", type: "Person", sourceFile: "doc1.md" },
    conn
  );
  await upsertEntity(
    { id: "codexmemory", name: "CodexMemory", type: "Project", sourceFile: "doc1.md" },
    conn
  );
  await upsertEntity(
    { id: "lancedb", name: "LanceDB", type: "Technology", sourceFile: "doc1.md" },
    conn
  );

  // Add directed relationships
  await addRelation("prasanna_kulal", "codexmemory", "BUILT", conn);
  await addRelation("codexmemory", "lancedb", "USES", conn);

  // Verify stats
  const stats = await getGraphStats(conn);
  assert.equal(stats.totalEntities, 3);
  assert.equal(stats.totalRelations, 2);

  // Verify multi-hop subgraph discovery
  const subgraph = await findConnectedSubgraph(["prasanna"], 2, conn);
  assert.ok(subgraph.length >= 1, "Should find connected relations for Prasanna");
  assert.ok(
    subgraph.some((s) => s.from.name === "Prasanna Kulal" && s.relation === "BUILT"),
    "Should traverse Prasanna -> BUILT -> CodexMemory"
  );

  // Verify getAllEntities
  const allEntities = await getAllEntities(10, conn);
  assert.equal(allEntities.length, 3);

  // Verify deletion by sourceFile
  await deleteDocumentGraph("doc1.md", conn);
  const afterStats = await getGraphStats(conn);
  assert.equal(afterStats.totalEntities, 0);
  assert.equal(afterStats.totalRelations, 0);
});
