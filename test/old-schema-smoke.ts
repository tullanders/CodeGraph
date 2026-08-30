import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Connection, Database } from "kuzu";
import { findSymbol, queryNeighbors, rethrowFriendlyIfStaleSchema, STALE_SCHEMA_MESSAGE } from "../src/mcp-server.js";

// Builds a database with the exact pre-branch schema (commit 284e100): no
// line/endLine on Type/Function, no unresolvedImports/unresolvedMocks on
// File, no unresolvedCalls on Function, and no GraphMeta table at all. This
// is what a graph seeded before this feature set looks like on disk today.
async function createOldSchemaDatabase(databasePath: string) {
  await mkdir(path.dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  const connection = new Connection(database);

  async function execute(statement: string) {
    const result = await connection.query(statement);
    const single = Array.isArray(result) ? result[0] : result;
    await single.close();
  }

  await execute("CREATE NODE TABLE File(path STRING, fileName STRING, PRIMARY KEY (path));");
  await execute("CREATE REL TABLE IMPORTS(FROM File TO File);");
  await execute("CREATE REL TABLE MOCKS(FROM File TO File);");
  await execute("CREATE NODE TABLE Type(path STRING, name STRING, kind STRING, PRIMARY KEY (path));");
  await execute("CREATE REL TABLE DECLARES(FROM File TO Type);");
  await execute("CREATE NODE TABLE Function(path STRING, name STRING, kind STRING, PRIMARY KEY (path));");
  await execute("CREATE REL TABLE HAS_FUNCTION(FROM File TO Function);");
  await execute("CREATE REL TABLE HAS_METHOD(FROM Type TO Function);");
  await execute("CREATE REL TABLE CALLS(FROM Function TO Function);");
  await execute("CREATE (:File {path: '/project/src/app.ts', fileName: 'app.ts'});");

  return { database, connection };
}

const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-old-schema-"));
const databasePath = path.join(root, "kuzu");

try {
  const { database, connection } = await createOldSchemaDatabase(databasePath);

  try {
    // find_symbol: a plain File search must not crash just because the
    // Type/Function branch of the query touches columns this old graph
    // doesn't have.
    await assert.rejects(
      () => findSymbol(connection, "app"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, STALE_SCHEMA_MESSAGE);
        return true;
      },
      "findSymbol mot en gammal graf ska ge det vänliga svenska felet, inte en rå binder exception",
    );

    // neighbors: fails on the very first query (File.unresolvedImports).
    await assert.rejects(
      () =>
        queryNeighbors(connection, {
          paths: ["/project/src/app.ts"],
          edges: ["IMPORTS"],
          direction: "out",
          depth: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, STALE_SCHEMA_MESSAGE);
        return true;
      },
      "queryNeighbors mot en gammal graf ska ge det vänliga svenska felet, inte en rå binder exception",
    );

    // Discrimination: only a binder exception naming one of the columns this
    // branch actually added (line, endLine, unresolvedImports,
    // unresolvedMocks, unresolvedCalls) gets relabelled. A binder exception
    // about anything else — a column that was never part of this migration —
    // is a genuine bug and must surface unchanged, not be swallowed into the
    // stale-schema message.
    assert.throws(
      () => rethrowFriendlyIfStaleSchema(new Error("Binder exception: Cannot find property doesNotExist for n.")),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.notEqual(error.message, STALE_SCHEMA_MESSAGE);
        assert.match(error.message, /doesNotExist/);
        return true;
      },
      "en binder exception om en okänd kolumn (inte en av branchens tillägg) ska inte döljas bakom stale-schema-meddelandet",
    );

    // A completely different exception shape (not a binder exception at all,
    // e.g. a real crash somewhere else) must also pass through untouched.
    assert.throws(
      () => rethrowFriendlyIfStaleSchema(new Error("Connection exception: Cannot open database.")),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Connection exception: Cannot open database.");
        return true;
      },
      "ett fel som inte är en binder exception om en tillagd kolumn ska passera oförändrat",
    );

    // A non-Error throw must also pass through untouched, never coerced.
    assert.throws(
      () => rethrowFriendlyIfStaleSchema("not an Error object"),
      (thrown: unknown) => thrown === "not an Error object",
      "ett kastat värde som inte är ett Error-objekt ska passera oförändrat",
    );

    // The exact shape this branch's own columns produce IS relabelled —
    // confirms the positive match for every added column, not just "line".
    for (const column of ["line", "endLine", "unresolvedImports", "unresolvedMocks", "unresolvedCalls"]) {
      assert.throws(
        () => rethrowFriendlyIfStaleSchema(new Error(`Binder exception: Cannot find property ${column} for n.`)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, STALE_SCHEMA_MESSAGE);
          return true;
        },
        `en binder exception om ${column} ska ge det vänliga meddelandet`,
      );
    }
  } finally {
    await connection.close();
    await database.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Old schema smoke test passed.");
