import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Connection, Database } from "kuzu";
import { describeFreshness, readGraphMeta } from "../src/graph-meta.js";
import { closeGraphDatabase, createGraphDatabase, openGraphDatabase } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const run = promisify(execFile);
const fixtureDirectory = path.resolve("test/fixtures/imports");

async function git(cwd: string, args: string[]) {
  await run("git", args, { cwd });
}

// Case 1: happy path — readGraphMeta round-trips what seedCodebase wrote.
async function testHappyPath() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-meta-"));
  const databasePath = path.join(temporaryDirectory, "kuzu");
  const tsconfigPath = path.join(fixtureDirectory, "tsconfig.json");

  try {
    const before = Date.now();
    const summary = await seedCodebase([tsconfigPath], databasePath);
    const { database, connection } = openGraphDatabase(databasePath);

    try {
      const meta = await readGraphMeta(connection);

      assert.ok(meta, "GraphMeta ska finnas efter en lyckad seedning");
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
}

// Case 2: describeFreshness against an isolated git repo — proves stale
// detection and changedFiles actually work, without depending on this
// repo's own working-tree state.
async function testStaleDetection() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codegraph-meta-git-"));

  try {
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true }, include: ["src/**/*.ts"] }),
    );
    await writeFile(path.join(projectRoot, "src", "index.ts"), "export const value = 1;\n");

    await git(projectRoot, ["init"]);
    await git(projectRoot, ["config", "user.email", "test@example.com"]);
    await git(projectRoot, ["config", "user.name", "Test"]);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "initial"]);

    const databasePath = path.join(projectRoot, ".codegraph", "kuzu");
    await seedCodebase([path.join(projectRoot, "tsconfig.json")], databasePath);

    const { database, connection } = openGraphDatabase(databasePath);

    try {
      const clean = await describeFreshness(connection, databasePath, projectRoot);
      assert.equal(clean.stale, false, "en nyss seedad, ren arbetskatalog ska inte vara stale");
      assert.deepEqual(clean.changedFiles, []);

      // Modify a .ts file without committing — the graph is now stale.
      await writeFile(path.join(projectRoot, "src", "index.ts"), "export const value = 2;\n");

      const dirty = await describeFreshness(connection, databasePath, projectRoot);
      assert.equal(dirty.stale, true, "en ändrad .ts-fil ska göra grafen stale");
      assert.deepEqual(dirty.changedFiles, ["src/index.ts"]);
    } finally {
      await closeGraphDatabase(database, connection);
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

// Case 3: GraphMeta table exists but has no rows (e.g. seeding crashed
// before writeGraphMeta ran) — must degrade honestly, not report fresh.
async function testEmptyGraphMetaTable() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-meta-empty-"));
  const databasePath = path.join(temporaryDirectory, "kuzu");
  const { database, connection } = await createGraphDatabase(databasePath);

  try {
    const meta = await readGraphMeta(connection);
    assert.equal(meta, undefined, "en tom GraphMeta-tabell ska tolkas som saknad metadata");

    const report = await describeFreshness(connection, databasePath, temporaryDirectory);
    assert.equal(report.stale, true, "saknad metadata får aldrig rapporteras som fräsch");
    assert.ok(report.reason, "en förklaring ska följa med när metadata saknas");
    assert.equal(report.seededAt, null);
    assert.equal(report.commit, null);
    assert.equal(report.tsconfigs, null);
    assert.equal(report.counts, null);
  } finally {
    await closeGraphDatabase(database, connection);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// Case 4: GraphMeta table missing entirely (a graph seeded before this
// feature existed) — readGraphMeta must not let the Binder exception escape.
async function testMissingGraphMetaTable() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-meta-missing-"));
  const databasePath = path.join(temporaryDirectory, "kuzu");
  await mkdir(path.dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  const connection = new Connection(database);

  try {
    const meta = await readGraphMeta(connection);
    assert.equal(meta, undefined, "en saknad GraphMeta-tabell ska tolkas som saknad metadata, inte krascha");

    const report = await describeFreshness(connection, databasePath, temporaryDirectory);
    assert.equal(report.stale, true);
    assert.ok(report.reason, "en förklaring ska följa med när tabellen saknas");
  } finally {
    await connection.close();
    await database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await testHappyPath();
await testStaleDetection();
await testEmptyGraphMetaTable();
await testMissingGraphMetaTable();

console.log("Graph meta smoke test passed.");
