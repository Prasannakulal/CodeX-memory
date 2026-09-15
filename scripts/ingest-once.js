import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { chunkText } from "../src/chunker.js";
import { embedText } from "../src/embedder.js";
import db from "../src/database.js";
import config from "../src/config.js";

const docsDirectory = config.docs.dir;

const files = await readdir(docsDirectory);

const markdownFiles = files.filter((file) => file.endsWith(".md"));

const records = [];

for (const fileName of markdownFiles) {
  const filePath = join(docsDirectory, fileName);
  const text = await readFile(filePath, "utf-8");
  const chunks = chunkText(text, 500, 50);

  console.log(`Processing ${filePath} — ${chunks.length} chunk(s)`);

  for (const [index, chunk] of chunks.entries()) {
    const embedding = await embedText(chunk);

    records.push({
      id: `${filePath}:${index}`,
      text: chunk,
      sourceFile: filePath,
      chunkIndex: index,
      vector: embedding,
    });
  }
}

if (records.length === 0) {
  console.log("No Markdown documents found.");
  process.exit(0);
}

const tableNames = await db.tableNames();

if (tableNames.includes("documents")) {
  await db.dropTable("documents");
}

await db.createTable("documents", records);

console.log(`Stored ${records.length} chunks from ${markdownFiles.length} file(s)`);