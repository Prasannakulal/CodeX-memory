import assert from "node:assert/strict";
import test from "node:test";

import { chunkText } from "../src/chunker.js";

test("chunkText splits text into overlapping word chunks", () => {
  const chunks = chunkText("one two three four five", 3, 1);

  assert.deepEqual(chunks, ["one two three", "three four five"]);
});
