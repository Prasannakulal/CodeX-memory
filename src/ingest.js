import { readFile } from "node:fs/promises";

import { chunkText } from "./chunker.js";
import { embedText } from "./embedder.js";

export async function ingestFile(filePath, { database, embed = embedText }) {
  const text = await readFile(filePath, "utf-8");
  const chunks = chunkText(text, 500, 50);

  const records = [];

  for (const [index, chunk] of chunks.entries()) {
    console.log(`Embedding ${filePath} chunk ${index + 1}/${chunks.length}`);

    const embedding = await embed(chunk, { taskType: "search_document" });

    records.push({
      id: `${filePath}:${index}`,
      text: chunk,
      sourceFile: filePath,
      chunkIndex: index,
      vector: embedding,
    });
  }

  const tableNames = await database.tableNames();

  if (!tableNames.includes("documents")) {
    await database.createTable("documents", records);
    return records.length;
  }

  const table = await database.openTable("documents");

  await table.delete(
    `\`sourceFile\` = '${filePath.replaceAll("'", "''")}'`
  );

  await table.add(records);

  // Extract and store knowledge graph entities & relationships
  try {
    const [{ extractGraphData }, { mergeIntoGraph }] = await Promise.all([
      import("./extractor.js"),
      import("./graph.js"),
    ]);

    const { entities, relations } = extractGraphData(text, filePath);

    const graphRelations = relations.map((r) => ({
      fromName: r.fromName || r.fromId,
      fromType: r.fromType || "Concept",
      fromSource: filePath,
      relation: r.relation || "RELATES_TO",
      toName: r.toName || r.toId,
      toType: r.toType || "Concept",
      toSource: filePath,
    }));
    const graphEntities = entities.map((e) => ({ ...e, sourceFile: filePath }));

    await mergeIntoGraph({
      entities: graphEntities,
      relations: graphRelations,
      sourceFile: filePath,
    });
  } catch (err) {
    console.warn(`[GraphRAG] Note on graph extraction for ${filePath}:`, err.message);
  }

  return records.length;
}
