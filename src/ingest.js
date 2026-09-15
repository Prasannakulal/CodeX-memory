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
    const [{ extractGraphData }, { getGraphConnection, upsertEntity, addRelation, deleteDocumentGraph }, { mergeIntoSnapshot }] = await Promise.all([
      import("./extractor.js"),
      import("./graph-db.js"),
      import("./graph-snapshot.js"),
    ]);

    const { entities, relations } = extractGraphData(text, filePath);

    // 1. Write to KùzuDB (for full graph traversal, optional)
    try {
      const graphConn = await getGraphConnection();
      if (graphConn) {
        await deleteDocumentGraph(filePath, graphConn);
        for (const entity of entities) {
          await upsertEntity(entity, graphConn);
        }
        for (const rel of relations) {
          await addRelation(rel.fromId, rel.toId, rel.relation, graphConn);
        }
      }
    } catch (kuzuErr) {
      console.warn(`[GraphRAG] KùzuDB write skipped for ${filePath}:`, kuzuErr.message);
    }

    // 2. Write JSON snapshot (used by HTTP server — no native addon needed)
    const snapshotRelations = relations.map((r) => ({
      fromName: r.fromName || r.fromId,
      fromType: r.fromType || "Concept",
      fromSource: filePath,
      relation: r.relation || "RELATES_TO",
      toName: r.toName || r.toId,
      toType: r.toType || "Concept",
      toSource: filePath,
    }));
    const snapshotEntities = entities.map((e) => ({ ...e, sourceFile: filePath }));
    await mergeIntoSnapshot({ entities: snapshotEntities, relations: snapshotRelations, sourceFile: filePath });
  } catch (err) {
    console.warn(`[GraphRAG] Note on graph extraction for ${filePath}:`, err.message);
  }

  return records.length;
}
