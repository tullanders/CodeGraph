import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeGraphDatabase, openGraphDatabase, singleResult } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const fixtureDirectory = path.resolve("test/fixtures/imports");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-seed-"));
const databasePath = path.join(temporaryDirectory, "kuzu");

await mkdir(path.join(fixtureDirectory, ".generated"), { recursive: true });
await writeFile(path.join(fixtureDirectory, ".generated", "ignored.ts"), "export const ignored = true;\n");

try {
  const summary = await seedCodebase(path.join(fixtureDirectory, "tsconfig.json"), databasePath);

  assert.deepEqual(summary, {
    files: 3,
    imports: 2,
    unresolvedImports: 1,
    mocks: 0,
    unresolvedMocks: 0,
    types: 2,
    functions: 3,
    calls: 2,
    unresolvedCalls: 0,
  });

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

    const typeResult = singleResult(await connection.query(`
      MATCH (file:File)-[:DECLARES]->(type:Type)
      RETURN file.fileName AS fileName, type.name AS name, type.kind AS kind
      ORDER BY fileName, name
    `));
    const typeRows = await typeResult.getAll();
    await typeResult.close();

    assert.deepEqual(typeRows, [
      { fileName: "app.ts", name: "Application", kind: "class" },
      { fileName: "format.ts", name: "Formatter", kind: "interface" },
    ]);

    const callResult = singleResult(await connection.query(`
      MATCH (caller:Function)-[:CALLS]->(callee:Function)
      RETURN caller.name AS callerName, callee.name AS calleeName
      ORDER BY callerName, calleeName
    `));
    const callRows = await callResult.getAll();
    await callResult.close();

    assert.deepEqual(callRows, [
      { callerName: "start", calleeName: "formatMessage" },
      { callerName: "start", calleeName: "formatMessage" },
    ]);
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(path.join(fixtureDirectory, ".generated"), { force: true, recursive: true });
  await rm(temporaryDirectory, { force: true, recursive: true });
}

console.log("Seed smoke test passed.");