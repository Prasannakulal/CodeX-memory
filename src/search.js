import db from "./database.js";
import { embedText } from "./embedder.js";

export async function searchDocuments(query, topK = 5) {
  if (!query || !query.trim()) {
    throw new Error("Search query cannot be empty");
  }

  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    throw new Error("topK must be an integer between 1 and 50");
  }

  const queryEmbedding = await embedText(query);

  const table = await db.openTable("documents");

  const results = await table
    .search(queryEmbedding)
    .limit(topK)
    .toArray();

  return results;
}