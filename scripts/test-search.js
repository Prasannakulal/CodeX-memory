import { searchDocuments } from "../src/search.js";

const results = await searchDocuments(
  "What technology is used to build CodexMemory?"
);

for (const [index, result] of results.entries()) {
  console.log(`\n--- Result ${index} ---`);
  console.log("Text:", result.text);
  console.log("Source:", result.sourceFile);
  console.log("Distance:", result._distance);
}