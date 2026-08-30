import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeGraphDatabase, openGraphDatabase, singleResult } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const fixture = path.resolve("test/fixtures/monorepo");
const appTsconfig = path.join(fixture, "apps", "web", "tsconfig.json");
const coreTsconfig = path.join(fixture, "packages", "core", "tsconfig.json");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-monorepo-"));

try {
  // App project only: the core file is not indexed, so the import counts as unresolved.
  const appOnlyPath = path.join(temporaryDirectory, "app-only");
  const appOnly = await seedCodebase([appTsconfig], appOnlyPath);
  assert.equal(appOnly.files, 1);
  assert.equal(appOnly.imports, 0);
  assert.equal(appOnly.unresolvedImports, 1);

  // Both projects: the core file becomes a node and the cross-package import becomes an edge.
  const bothPath = path.join(temporaryDirectory, "both");
  const both = await seedCodebase([appTsconfig, coreTsconfig], bothPath);
  assert.equal(both.files, 2);
  assert.equal(both.imports, 1);
  assert.equal(both.unresolvedImports, 0);

  const { database, connection } = openGraphDatabase(bothPath);
  try {
    const result = singleResult(await connection.query(`
      MATCH (source:File)-[:IMPORTS]->(target:File)
      RETURN source.fileName AS sourceName, target.fileName AS targetName
    `));
    const rows = await result.getAll();
    await result.close();
    assert.deepEqual(rows, [{ sourceName: "web.ts", targetName: "core.ts" }]);
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("Monorepo smoke test passed.");
