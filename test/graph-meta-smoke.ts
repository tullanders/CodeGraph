import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readGraphMeta } from "../src/graph-meta.js";
import { closeGraphDatabase, openGraphDatabase } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const fixtureDirectory = path.resolve("test/fixtures/imports");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-meta-"));
const databasePath = path.join(temporaryDirectory, "kuzu");
const tsconfigPath = path.join(fixtureDirectory, "tsconfig.json");

try {
  const before = Date.now();
  const summary = await seedCodebase([tsconfigPath], databasePath);
  const { database, connection } = openGraphDatabase(databasePath);

  try {
    const meta = await readGraphMeta(connection);

    assert.deepEqual(meta.tsconfigs, [tsconfigPath]);
    assert.deepEqual(meta.counts, summary);
    assert.ok(Date.parse(meta.seededAt) >= before - 1000, "seededAt ska ligga vid seedningstillfället");
    assert.equal(typeof meta.commit, "string");
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("Graph meta smoke test passed.");
