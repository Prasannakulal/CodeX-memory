import assert from "node:assert/strict";
import test from "node:test";

import { searchDocuments } from "../src/search.js";

test("searchDocuments rejects empty search queries", async () => {
  await assert.rejects(
    searchDocuments("   "),
    /Search query cannot be empty/
  );
});

test("searchDocuments rejects invalid topK values", async () => {
  for (const topK of [0, 1.5, 51]) {
    await assert.rejects(
      searchDocuments("valid query", topK),
      /topK must be an integer between 1 and 50/
    );
  }
});

test("searchDocuments returns relevant document as rank #1 with hybrid match metadata", async () => {
  const results = await searchDocuments("can i know more abut prasanna", 3);
  assert.ok(results.length > 0, "Should return at least one result");
  assert.ok(results[0].sourceFile.includes("prasanna.md"), "Rank #1 should be prasanna.md");
  assert.equal(results[0].matchType, "hybrid");
  assert.ok(results[0].score > 0.5, "Rank #1 should have strong confidence score");
  assert.ok(typeof results[0]._distance === "number", "_distance must be preserved for backward compatibility");
});

