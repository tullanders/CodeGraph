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

  // Andra anropet ska träffa den varma anslutningen.
  const cached = await withConnection(databasePath, (connection) => findSymbol(connection, "before"));
  assert.equal(cached.length, 1);

  // Seeda om med annat innehåll. En varm anslutning utan detektion
  // fortsätter servera den gamla grafen här — tyst.
  await writeFile(path.join(source, "a.ts"), "export function after() { return 2; }\n");
  await seedCodebase([tsconfigPath], databasePath);

  const stale = await withConnection(databasePath, (connection) => findSymbol(connection, "before"));
  assert.deepEqual(stale, [], "before() ska vara borta efter omseedning");

  const fresh = await withConnection(databasePath, (connection) => findSymbol(connection, "after"));
  assert.equal(fresh.length, 1, "after() ska finnas efter omseedning");
} finally {
  await closeCachedConnection();
  await rm(root, { recursive: true, force: true });
}

console.log("Warm connection smoke test passed.");
