import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findGraphDatabase, graphDatabasePathFor, searchedDirectories } from "../src/paths.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-paths-"));
const nested = path.join(root, "apps", "app", "src");
await mkdir(nested, { recursive: true });

try {
  // No graph anywhere in the chain.
  assert.equal(findGraphDatabase(nested), undefined);

  // A graph at the repo root is found from a deep subdirectory.
  await mkdir(path.join(root, ".codegraph"), { recursive: true });
  await writeFile(path.join(root, ".codegraph", "kuzu"), "");
  assert.equal(findGraphDatabase(nested), path.join(root, ".codegraph", "kuzu"));

  // A closer graph wins over one at the root.
  const appRoot = path.join(root, "apps", "app");
  await mkdir(path.join(appRoot, ".codegraph"), { recursive: true });
  await writeFile(path.join(appRoot, ".codegraph", "kuzu"), "");
  assert.equal(findGraphDatabase(nested), path.join(appRoot, ".codegraph", "kuzu"));

  // graphDatabasePathFor computes the path without requiring it to exist.
  assert.equal(
    graphDatabasePathFor(path.join(root, "packages", "pdf")),
    path.join(root, "packages", "pdf", ".codegraph", "kuzu"),
  );

  // The error message should be able to list where it searched, root included.
  const searched = searchedDirectories(nested);
  assert.ok(searched.includes(nested));
  assert.ok(searched.includes(root));
  assert.equal(searched[0], nested);
  assert.equal(searched.at(-1), path.parse(root).root);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Paths smoke test passed.");
