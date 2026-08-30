import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findAdditionalTsconfigs, readTsconfigPaths, writeTsconfigPaths } from "../src/config.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-config-"));

try {
  // Round trip: write two tsconfig paths (one nested), read them back as
  // absolute paths that point at the same files.
  const appTsconfig = path.join(root, "tsconfig.json");
  const pdfTsconfig = path.join(root, "packages", "pdf", "tsconfig.json");
  await mkdir(path.dirname(pdfTsconfig), { recursive: true });

  await writeTsconfigPaths(root, [appTsconfig, pdfTsconfig]);
  const roundTripped = await readTsconfigPaths(root);
  assert.deepEqual(roundTripped.sort(), [appTsconfig, pdfTsconfig].sort(), "readTsconfigPaths ska returnera samma sökvägar som skrevs");

  // Paths are stored RELATIVE to the project root on disk, not absolute —
  // that's what lets .codegraph/config.json be committed and shared across
  // a team without baking in anyone's home directory.
  const configPath = path.join(root, ".codegraph", "config.json");
  const onDisk = JSON.parse(await readFile(configPath, "utf8")) as { tsconfigs: string[] };
  assert.deepEqual(
    onDisk.tsconfigs.sort(),
    ["tsconfig.json", path.join("packages", "pdf", "tsconfig.json")].sort(),
    "config.json ska lagra relativa sökvägar, inte absoluta",
  );
  for (const entry of onDisk.tsconfigs) {
    assert.ok(!path.isAbsolute(entry), `${entry} ska vara relativ, inte absolut`);
  }

  // ENOENT fallback: no config.json at all falls back to <root>/tsconfig.json.
  const freshRoot = await mkdtemp(path.join(os.tmpdir(), "codegraph-config-fresh-"));
  try {
    const fallback = await readTsconfigPaths(freshRoot);
    assert.deepEqual(fallback, [path.join(freshRoot, "tsconfig.json")], "utan config.json ska standard-tsconfig.json användas");
  } finally {
    await rm(freshRoot, { recursive: true, force: true });
  }

  // Non-empty-array validation: a config.json with an empty tsconfigs list
  // must be rejected, not silently treated as "seed nothing".
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "codegraph-config-empty-"));
  try {
    await mkdir(path.join(emptyRoot, ".codegraph"), { recursive: true });
    await writeFile(path.join(emptyRoot, ".codegraph", "config.json"), JSON.stringify({ tsconfigs: [] }));

    await assert.rejects(
      () => readTsconfigPaths(emptyRoot),
      /tsconfigs/,
      "en tom tsconfigs-lista i config.json ska kastas som ett fel, inte accepteras tyst",
    );
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }

  // Also reject a config.json whose tsconfigs isn't an array at all.
  const malformedRoot = await mkdtemp(path.join(os.tmpdir(), "codegraph-config-malformed-"));
  try {
    await mkdir(path.join(malformedRoot, ".codegraph"), { recursive: true });
    await writeFile(path.join(malformedRoot, ".codegraph", "config.json"), JSON.stringify({ tsconfigs: "not-an-array" }));

    await assert.rejects(
      () => readTsconfigPaths(malformedRoot),
      /tsconfigs/,
      "en tsconfigs som inte är en lista ska kastas som ett fel",
    );
  } finally {
    await rm(malformedRoot, { recursive: true, force: true });
  }
  // findAdditionalTsconfigs: a monorepo whose root tsconfig is the only one
  // seeded silently leaves whole packages out of the graph. The single most
  // expensive way to be wrong about CodeGraph is to search a package that was
  // never indexed and read the empty result as "this code doesn't exist", so
  // init has to say out loud what it did not seed.
  const monorepo = await mkdtemp(path.join(os.tmpdir(), "codegraph-scan-"));
  try {
    const rootTsconfig = path.join(monorepo, "tsconfig.json");
    const appTsconfig = path.join(monorepo, "apps", "app", "tsconfig.json");
    const pdfTsconfig = path.join(monorepo, "packages", "pdf", "tsconfig.json");
    // Must never be offered: a dependency's own tsconfig, and a worktree copy
    // under a dot-directory — both would seed files the user never edits.
    const vendored = path.join(monorepo, "node_modules", "some-package", "tsconfig.json");
    const worktree = path.join(monorepo, ".claude", "worktrees", "feat", "tsconfig.json");
    // Deeper than the scan goes: the walk is bounded so init stays cheap on a
    // large repository rather than descending the whole tree.
    const tooDeep = path.join(monorepo, "a", "b", "c", "d", "e", "tsconfig.json");

    for (const file of [rootTsconfig, appTsconfig, pdfTsconfig, vendored, worktree, tooDeep]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{}\n");
    }

    assert.deepEqual(
      await findAdditionalTsconfigs(monorepo, [rootTsconfig]),
      [appTsconfig, pdfTsconfig],
      "bara riktiga paket-tsconfig ska föreslås — inte node_modules, inte dolda kataloger, inte djupare än vandringen går",
    );

    // Already chosen is already covered: only what is genuinely missing is
    // reported, otherwise the suggestion becomes noise the user learns to skip.
    assert.deepEqual(
      await findAdditionalTsconfigs(monorepo, [rootTsconfig, pdfTsconfig]),
      [appTsconfig],
      "en tsconfig som redan ingår ska inte föreslås igen",
    );

    assert.deepEqual(
      await findAdditionalTsconfigs(monorepo, [rootTsconfig, appTsconfig, pdfTsconfig]),
      [],
      "när allt ingår ska ingenting föreslås",
    );
  } finally {
    await rm(monorepo, { recursive: true, force: true });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Config smoke test passed.");
