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

    // unresolvedCalls must be a real measurement, not a fabricated 0: the
    // function-level count and the file-level rollup must agree, since
    // unresolved.ts's only function is useHelper.
    const unresolvedFilePath = path.join(fixtureDirectory, "src", "unresolved.ts");
    const useHelperPath = `${unresolvedFilePath}:useHelper`;

    const functionLevel = await queryNeighbors(connection, {
      paths: [useHelperPath],
      edges: ["CALLS"],
      direction: "out",
      depth: 1,
    });
    assert.equal(functionLevel.unresolved[useHelperPath].unresolvedCalls, 1);
    // A Function has no imports/mocks of its own: null, not a fabricated 0.
    assert.equal(functionLevel.unresolved[useHelperPath].unresolvedImports, null);
    assert.equal(functionLevel.unresolved[useHelperPath].unresolvedMocks, null);

    const fileLevel = await queryNeighbors(connection, {
      paths: [unresolvedFilePath],
      edges: ["CALLS"],
      direction: "out",
      depth: 1,
    });
    assert.equal(fileLevel.unresolved[unresolvedFilePath].unresolvedCalls, 1);

    // A path that backs no node at all is reported as unknown, never silently
    // conflated with "found, no neighbours".
    const missing = await queryNeighbors(connection, {
      paths: ["/nope/does-not-exist.ts"],
      edges: ["IMPORTS"],
      direction: "out",
      depth: 1,
    });
    assert.deepEqual(missing.nodes, []);
    assert.deepEqual(missing.unresolved, {});
    assert.deepEqual(missing.unknownPaths, ["/nope/does-not-exist.ts"]);

    // The interpolation rule's entire defence is the Zod enum plus this runtime
    // guard. Both a non-enum relation and a non-enum direction must be rejected,
    // not silently coerced into a query.
    await assert.rejects(() =>
      queryNeighbors(connection, {
        paths: [unresolvedFilePath],
        edges: ["DROP TABLE File" as unknown as "CALLS"],
        direction: "out",
        depth: 1,
      }),
    );
    await assert.rejects(() =>
      queryNeighbors(connection, {
        paths: [unresolvedFilePath],
        edges: ["IMPORTS"],
        direction: "sideways" as unknown as "out",
        depth: 1,
      }),
    );
    await assert.rejects(() =>
      queryNeighbors(connection, {
        paths: [unresolvedFilePath],
        edges: ["IMPORTS"],
        direction: "out",
        depth: 2.5,
      }),
    );
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("Tools smoke test passed.");
