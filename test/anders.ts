import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeGraphDatabase, openGraphDatabase, singleResult } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const fixtureDirectory = path.resolve("test/fixtures/imports");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-seed-"));
const databasePath = path.join('../.codegraph','kuzu');

try {
  const summary = await seedCodebase(path.join(fixtureDirectory, "tsconfig.json"), databasePath);

  assert.deepEqual(summary, { files: 3, imports: 2, unresolvedImports: 1 });

  const { database, connection } = openGraphDatabase(databasePath);
  try {
    const result = singleResult(await connection.query(`
      MATCH (source:File)-[:IMPORTS]->(target:File)
      RETURN source.path AS sourcePath, target.path AS targetPath
      ORDER BY sourcePath, targetPath
    `));
    const rows = await result.getAll();
    await result.close();

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => {
        const { sourcePath, targetPath } = row;
        if (typeof sourcePath !== "string" || typeof targetPath !== "string") {
          throw new Error("Expected Kuzu to return string file paths.");
        }

        return [path.basename(sourcePath), path.basename(targetPath)];
      }),
      [
        ["app.ts", "format.ts"],
        ["index.ts", "app.ts"],
      ],
    );
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

console.log("Seed smoke test passed.");