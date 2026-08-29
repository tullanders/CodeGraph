import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findSymbol, queryNeighbors } from "../src/mcp-server.js";
import { closeGraphDatabase, openGraphDatabase } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const fixtureDirectory = path.resolve("test/fixtures/imports");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-tools-"));
const databasePath = path.join(temporaryDirectory, "kuzu");

try {
  await seedCodebase([path.join(fixtureDirectory, "tsconfig.json")], databasePath);
  const { database, connection } = openGraphDatabase(databasePath);

  try {
    const symbols = await findSymbol(connection, "formatMessage");
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "formatMessage");
    assert.equal(symbols[0].nodeType, "Function");
    assert.equal(symbols[0].line, 5);
    assert.equal(symbols[0].endLine, 7);

    // Callers of formatMessage: both the method and the standalone function.
    const callers = await queryNeighbors(connection, {
      paths: [symbols[0].path],
      edges: ["CALLS"],
      direction: "in",
      depth: 1,
    });
    assert.deepEqual(callers.nodes.map((node) => node.name).sort(), ["start", "start"]);
    assert.ok(callers.nodes.every((node) => typeof node.line === "number"));

    // File neighbors in both directions across one import.
    const appPath = symbols[0].path.split(":")[0].replace("format.ts", "app.ts");
    const around = await queryNeighbors(connection, {
      paths: [appPath],
      edges: ["IMPORTS"],
      direction: "both",
      depth: 1,
    });
    assert.deepEqual(
      around.nodes.map((node) => path.basename(node.path)).sort(),
      ["format.ts", "index.ts"],
    );

    // Honestly empty: index.ts mocks nothing internal, but reports its unresolved counts.
    const indexPath = appPath.replace("app.ts", "index.ts");
    const mocks = await queryNeighbors(connection, {
      paths: [indexPath],
      edges: ["MOCKS"],
      direction: "out",
      depth: 1,
    });
    assert.deepEqual(mocks.nodes, []);
    assert.equal(mocks.unresolved[indexPath].unresolvedImports, 1);
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("Tools smoke test passed.");
