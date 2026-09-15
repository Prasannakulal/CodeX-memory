export async function deleteDocument(filePath, database) {
  const activeDatabase = database ?? (await import("./database.js")).default;
  const tableNames = await activeDatabase.tableNames();

  if (!tableNames.includes("documents")) {
    console.log("Documents table does not exist. Nothing to delete.");
    return;
  }

  const table = await activeDatabase.openTable("documents");

  await table.delete(
    `\`sourceFile\` = '${filePath.replaceAll("'", "''")}'`
  );

  try {
    const { deleteDocumentGraph } = await import("./graph-db.js");
    await deleteDocumentGraph(filePath);
  } catch {}

  try {
    const { removeFromSnapshot } = await import("./graph-snapshot.js");
    await removeFromSnapshot(filePath);
  } catch {}

  console.log(`Deleted indexed chunks for ${filePath}`);
}
