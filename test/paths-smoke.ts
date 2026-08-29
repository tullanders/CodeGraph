import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findGraphDatabase, graphDatabasePathFor, searchedDirectories } from "../src/paths.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-paths-"));
const nested = path.join(root, "apps", "app", "src");
await mkdir(nested, { recursive: true });

try {
  // Ingen graf någonstans i kedjan.
  assert.equal(findGraphDatabase(nested), undefined);

  // Graf i repo-roten hittas från en djup underkatalog.
  await mkdir(path.join(root, ".codegraph"), { recursive: true });
  await writeFile(path.join(root, ".codegraph", "kuzu"), "");
  assert.equal(findGraphDatabase(nested), path.join(root, ".codegraph", "kuzu"));

  // En närmare graf vinner över en i roten.
  const appRoot = path.join(root, "apps", "app");
  await mkdir(path.join(appRoot, ".codegraph"), { recursive: true });
  await writeFile(path.join(appRoot, ".codegraph", "kuzu"), "");
  assert.equal(findGraphDatabase(nested), path.join(appRoot, ".codegraph", "kuzu"));

  // graphDatabasePathFor räknar ut sökvägen utan att kräva att den finns.
  assert.equal(
    graphDatabasePathFor(path.join(root, "packages", "pdf")),
    path.join(root, "packages", "pdf", ".codegraph", "kuzu"),
  );

  // Felmeddelandet ska kunna räkna upp var det letades, rot inkluderad.
  const searched = searchedDirectories(nested);
  assert.ok(searched.includes(nested));
  assert.ok(searched.includes(root));
  assert.equal(searched[0], nested);
  assert.equal(searched.at(-1), path.parse(root).root);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Paths smoke test passed.");
