import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeGraphDatabase, createGraphDatabase, singleResult } from "./schema.js";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-kuzu-"));
const databasePath = path.join(temporaryDirectory, "smoke-test");

try {
  const { database, connection } = await createGraphDatabase(databasePath);
  try {
    const result = singleResult(await connection.query("RETURN 1 AS value"));
    const rows = await result.getAll();
    await result.close();

    if (rows.length !== 1 || rows[0].value !== 1) {
      throw new Error("Kuzu smoke test returned an unexpected result.");
    }
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

console.log("Kuzu smoke test passed.");