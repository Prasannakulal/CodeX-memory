import * as lancedb from "@lancedb/lancedb";

const db = await lancedb.connect("./data/lancedb");

export default db;