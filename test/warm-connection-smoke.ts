import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeCachedConnection, findSymbol, withConnection } from "../src/mcp-server.js";
import { seedCodebase } from "../src/seed.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-warm-"));
const source = path.join(root, "src");
await mkdir(source, { recursive: true });
await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
  compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true },
  include: ["src/**/*.ts"],
}));
const databasePath = path.join(root, ".codegraph", "kuzu");
const tsconfigPath = path.join(root, "tsconfig.json");

try {
  await writeFile(path.join(source, "a.ts"), "export function before() { return 1; }\n");
  await seedCodebase([tsconfigPath], databasePath);

  const first = await withConnection(databasePath, (connection) => findSymbol(connection, "before"));
  assert.equal(first.length, 1, "ska hitta before() efter första seedningen");

  // The second call should hit the warm connection.
  const cached = await withConnection(databasePath, (connection) => findSymbol(connection, "before"));
  assert.equal(cached.length, 1);

  // Reseed with different content. A warm connection without detection
  // keeps serving the old graph here — silently.
  await writeFile(path.join(source, "a.ts"), "export function after() { return 2; }\n");
  await seedCodebase([tsconfigPath], databasePath);

  const stale = await withConnection(databasePath, (connection) => findSymbol(connection, "before"));
  assert.deepEqual(stale, [], "before() ska vara borta efter omseedning");

  const fresh = await withConnection(databasePath, (connection) => findSymbol(connection, "after"));
  assert.equal(fresh.length, 1, "after() ska finnas efter omseedning");

  // Concurrency: the MCP SDK dispatches tool calls without awaiting the
  // previous one to finish (fire-and-forget `Promise.resolve().then(...)`
  // dispatch in the SDK's protocol layer), so many withConnection calls can
  // genuinely be in flight together, with a reseed landing in the middle.
  // Kuzu's connection.close() does not wait for or coordinate with an
  // outstanding query, so without serializing withConnection, a call that
  // detects the reseed can close the shared connection while another call
  // is still mid-query against it. This is not theoretical: with the
  // promise-chain serialization removed from withConnection, this exact
  // load (two rounds of ten concurrent calls each racing a reseed)
  // reliably killed the whole process with an uncaught native exception —
  // "Buffer manager exception: Mmap for size ... failed" — not even a
  // catchable rejection (see this task's fix report for the transcript).
  // With withConnection serialized, the same load never crashes: every
  // call either resolves with real data or rejects with an ordinary Error.
  for (let round = 0; round < 2; round++) {
    const symbolName = `race${round}`;
    await writeFile(path.join(source, "a.ts"), `export function ${symbolName}() { return ${round}; }\n`);

    const calls = [
      ...Array.from({ length: 10 }, () => withConnection(databasePath, (connection) => findSymbol(connection, symbolName))),
      seedCodebase([tsconfigPath], databasePath),
    ];

    const settled = await Promise.allSettled(calls);
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        assert.ok(
          outcome.reason instanceof Error,
          `ett samtidigt anrop under omseedning ska antingen lyckas eller misslyckas rent med ett Error, inte krascha: ${String(outcome.reason)}`,
        );
      }
    }
  }

  // After the concurrent load, the graph must reflect the LAST round's
  // content, not a stale one left over from a connection that raced a reseed.
  const finalFresh = await withConnection(databasePath, (connection) => findSymbol(connection, "race1"));
  assert.equal(finalFresh.length, 1, "race1() ska finnas efter samtidig belastning och omseedningar");
  const finalStale = await withConnection(databasePath, (connection) => findSymbol(connection, "race0"));
  assert.deepEqual(finalStale, [], "race0() ska vara borta efter samtidig belastning och omseedningar");
} finally {
  await closeCachedConnection();
  await rm(root, { recursive: true, force: true });
}

console.log("Warm connection smoke test passed.");
