import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as lancedb from "@lancedb/lancedb";

import { deleteDocument } from "../src/delete-document.js";
import { ingestFile } from "../src/ingest.js";

function fakeEmbed(text) {
  return [text.length, 1, 0];
}

async function createTestFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "codexmemory-test-"));
  const databasePath = join(directory, "lancedb");
  const database = await lancedb.connect(databasePath);

  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  return { database, databasePath, directory };
}

async function readRows(databasePath) {
  const database = await lancedb.connect(databasePath);

  try {
    const table = await database.openTable("documents");

    try {
      return await table.query().toArray();
    } finally {
      table.close();
    }
  } finally {
    database.close();
  }
}

test("ingestFile stores document chunks in LanceDB", async (t) => {
  const { database, databasePath, directory } = await createTestFixture(t);
  const filePath = join(directory, "document.md");
  await writeFile(filePath, "A document stored through the ingestion pipeline.");

  const count = await ingestFile(filePath, { database, embed: fakeEmbed });
  const rows = await readRows(databasePath);

  assert.equal(count, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceFile, filePath);
  assert.equal(rows[0].chunkIndex, 0);
  assert.equal(rows[0].text, "A document stored through the ingestion pipeline.");
});

test("ingestFile replaces existing chunks for an updated document", async (t) => {
  const { database, databasePath, directory } = await createTestFixture(t);
  const filePath = join(directory, "document.md");
  await writeFile(filePath, "original document content");
  await ingestFile(filePath, { database, embed: fakeEmbed });

  await writeFile(filePath, "updated document content");
  const count = await ingestFile(filePath, { database, embed: fakeEmbed });
  const rows = await readRows(databasePath);

  assert.equal(count, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "updated document content");
});

test("deleteDocument removes a document's LanceDB chunks", async (t) => {
  const { database, databasePath, directory } = await createTestFixture(t);
  const filePath = join(directory, "document.md");
  await writeFile(filePath, "document to delete");
  await ingestFile(filePath, { database, embed: fakeEmbed });

  await deleteDocument(filePath, database);

  const rows = await readRows(databasePath);
  assert.equal(rows.length, 0);
});
