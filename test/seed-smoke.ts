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
  const summary = await seedCodebase([path.join(fixtureDirectory, "tsconfig.json")], databasePath);

  assert.deepEqual(summary, {
    files: 3,
    imports: 2,
    unresolvedImports: 1,
    mocks: 0,
    unresolvedMocks: 0,
    types: 3,
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
      RETURN file.fileName AS fileName, type.name AS name, type.kind AS kind,
             type.line AS line, type.endLine AS endLine
      ORDER BY fileName, name
    `));
    const typeRows = await typeResult.getAll();
    await typeResult.close();

    assert.deepEqual(typeRows, [
      { fileName: "app.ts", name: "Application", kind: "class", line: 3, endLine: 7 },
      { fileName: "format.ts", name: "Formatter", kind: "interface", line: 1, endLine: 3 },
      { fileName: "format.ts", name: "FormatterOptions", kind: "typeAlias", line: 9, endLine: 11 },
    ]);

    const functionResult = singleResult(await connection.query(`
      MATCH (fn:Function)
      RETURN fn.name AS name, fn.kind AS kind, fn.line AS line, fn.endLine AS endLine
      ORDER BY name, line
    `));
    const functionRows = await functionResult.getAll();
    await functionResult.close();

    assert.deepEqual(functionRows, [
      { name: "formatMessage", kind: "function", line: 5, endLine: 7 },
      { name: "start", kind: "method", line: 4, endLine: 6 },
      { name: "start", kind: "function", line: 9, endLine: 11 },
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

    const unresolvedResult = singleResult(await connection.query(`
      MATCH (file:File)
      RETURN file.fileName AS fileName,
             file.unresolvedImports AS unresolvedImports,
             file.unresolvedMocks AS unresolvedMocks
      ORDER BY fileName
    `));
    const unresolvedRows = await unresolvedResult.getAll();
    await unresolvedResult.close();

    // index.ts imports node:path, which lies outside the project.
    assert.deepEqual(unresolvedRows, [
      { fileName: "app.ts", unresolvedImports: 0, unresolvedMocks: 0 },
      { fileName: "format.ts", unresolvedImports: 0, unresolvedMocks: 0 },
      { fileName: "index.ts", unresolvedImports: 1, unresolvedMocks: 0 },
    ]);
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(path.join(fixtureDirectory, ".generated"), { force: true, recursive: true });
  await rm(temporaryDirectory, { force: true, recursive: true });
}

console.log("Seed smoke test passed.");