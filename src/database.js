import * as lancedb from "@lancedb/lancedb";
import config from "./config.js";

const db = await lancedb.connect(config.database.path);

export default db;