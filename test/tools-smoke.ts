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

    // Matching is case-insensitive: an agent that searches "party" must still
    // find createParty. Case-sensitive CONTAINS is the single most common
    // cause of a false empty result, since callers rarely know the exact
    // casing of the symbol they are looking for.
    for (const query of ["formatmessage", "FORMATMESSAGE", "FormatMessage"]) {
      const insensitive = await findSymbol(connection, query);
      assert.deepEqual(
        insensitive.map((match) => match.name),
        ["formatMessage"],
        `"${query}" ska hitta formatMessage oavsett skiftläge`,
      );
    }

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
    assert.equal(mocks.counts[indexPath].unresolvedImports, 1);

    // unresolvedCalls must be a real measurement, not a fabricated 0.
    const unresolvedFilePath = path.join(fixtureDirectory, "src", "unresolved.ts");
    const useHelperPath = `${unresolvedFilePath}:useHelper`;

    const functionLevel = await queryNeighbors(connection, {
      paths: [useHelperPath],
      edges: ["CALLS"],
      direction: "out",
      depth: 1,
    });
    assert.deepEqual(functionLevel.nodes.map((node) => node.name), ["helper"]);
    assert.equal(functionLevel.counts[useHelperPath].unresolvedCalls, 0);
    assert.equal(functionLevel.counts[useHelperPath].externalCalls, 0);
    // A Function has no imports/mocks of its own: null, not a fabricated 0.
    assert.equal(functionLevel.counts[useHelperPath].unresolvedImports, null);
    assert.equal(functionLevel.counts[useHelperPath].unresolvedMocks, null);

    // A call into the TypeScript lib is external, never unresolved: reporting
    // JSON.stringify as call debt is what made a healthy graph look broken.
    const useExternalPath = `${unresolvedFilePath}:useExternal`;
    const externalLevel = await queryNeighbors(connection, {
      paths: [useExternalPath],
      edges: ["CALLS"],
      direction: "out",
      depth: 1,
    });
    assert.equal(externalLevel.counts[useExternalPath].externalCalls, 1);
    assert.equal(externalLevel.counts[useExternalPath].unresolvedCalls, 0);

    // Both counters roll up to the file, and the two never bleed into each
    // other: unresolved.ts holds two external calls (useExternal, helper) and
    // one genuine miss (useUnknown).
    const fileLevel = await queryNeighbors(connection, {
      paths: [unresolvedFilePath],
      edges: ["CALLS"],
      direction: "out",
      depth: 1,
    });
    assert.equal(fileLevel.counts[unresolvedFilePath].externalCalls, 2);
    assert.equal(fileLevel.counts[unresolvedFilePath].unresolvedCalls, 1);

    // A Type carries none of these counters — null across the board, and the
    // new one must not break that by defaulting to 0.
    const typePath = `${path.join(fixtureDirectory, "src", "app.ts")}:Application`;
    const typeLevel = await queryNeighbors(connection, {
      paths: [typePath],
      edges: ["HAS_METHOD"],
      direction: "out",
      depth: 1,
    });
    assert.equal(typeLevel.counts[typePath].externalCalls, null);

    // A path that backs no node at all is reported as unknown, never silently
    // conflated with "found, no neighbours".
    const missing = await queryNeighbors(connection, {
      paths: ["/nope/does-not-exist.ts"],
      edges: ["IMPORTS"],
      direction: "out",
      depth: 1,
    });
    assert.deepEqual(missing.nodes, []);
    assert.deepEqual(missing.counts, {});
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
