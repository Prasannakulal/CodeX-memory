import assert from "node:assert/strict";
import test from "node:test";
import { extractGraphData } from "../src/extractor.js";
import {
  mergeIntoGraph,
  findConnectedSubgraph,
  getGraphStats,
  removeFromGraph,
} from "../src/graph.js";

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

test("Graph engine merges data, traverses multi-hop connections, and cleans up", async () => {
  const testFile = "/test/doc-test.md";

  const entities = [
    { id: "prasanna_kulal", name: "Prasanna Kulal", type: "Person", sourceFile: testFile },
    { id: "codexmemory", name: "CodexMemory", type: "Project", sourceFile: testFile },
    { id: "lancedb", name: "LanceDB", type: "Technology", sourceFile: testFile },
  ];

  const relations = [
    {
      fromId: "prasanna_kulal",
      fromName: "Prasanna Kulal",
      fromType: "Person",
      fromSource: testFile,
      relation: "BUILT",
      toId: "codexmemory",
      toName: "CodexMemory",
      toType: "Project",
      toSource: testFile,
    },
    {
      fromId: "codexmemory",
      fromName: "CodexMemory",
      fromType: "Project",
      fromSource: testFile,
      relation: "USES",
      toId: "lancedb",
      toName: "LanceDB",
      toType: "Technology",
      toSource: testFile,
    },
  ];

  // 1. Merge into graph
  await mergeIntoGraph({ entities, relations, sourceFile: testFile });

  // 2. Query stats
  const stats = await getGraphStats();
  assert.ok(stats.totalEntities >= 3, "Should have stored entities");
  assert.ok(stats.totalRelations >= 2, "Should have stored relations");

  // 3. Multi-hop traversal (Prasanna -> CodexMemory -> LanceDB)
  const facts = await findConnectedSubgraph(["Prasanna"], 2);
  assert.ok(facts.length > 0, "Should find connected subgraph");
  const hasRelation = facts.some(
    (f) => f.from.name === "Prasanna Kulal" && f.relation === "BUILT"
  );
  assert.ok(hasRelation, "Should traverse BUILT relation");

  // 4. Cleanup
  await removeFromGraph(testFile);
});
