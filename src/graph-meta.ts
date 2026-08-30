import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connection } from "kuzu";
import { singleResult } from "./schema.js";
import type { SeedSummary } from "./seed.js";

const run = promisify(execFile);

// All four are always written together, at the end of a successful seed.
// If any is missing, the metadata is not merely sparse — it never finished
// writing, and must be treated as absent, not as a valid-but-empty record.
const REQUIRED_KEYS = ["seededAt", "commit", "tsconfigs", "counts"] as const;

export interface GraphMeta {
  seededAt: string;
  commit: string;
  tsconfigs: string[];
  counts: SeedSummary;
}

// seededAt/commit/tsconfigs/counts are null together, exactly when metadata
// is absent (GraphMeta table missing, or present but incomplete). `reason`
// is set in that case and explains why, so an agent never mistakes "we
// don't know" for "confirmed fresh".
export interface FreshnessReport {
  databasePath: string;
  ageMinutes: number;
  currentCommit: string;
  changedFiles: string[];
  stale: boolean;
  reason?: string;
  seededAt: string | null;
  commit: string | null;
  tsconfigs: string[] | null;
  counts: SeedSummary | null;
}

// Empty value when the directory isn't a git repo — freshness should degrade,
// not throw. Only trailing whitespace is trimmed: `git status --porcelain`
// output carries meaningful leading spaces in its status codes (e.g.
// " M path"), and a plain .trim() would eat the first line's leading
// space and misalign every downstream slice(3).
async function git(projectRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: projectRoot });
    return stdout.replace(/\s+$/, "");
  } catch {
    return "";
  }
}

export async function currentCommit(projectRoot: string): Promise<string> {
  return git(projectRoot, ["rev-parse", "HEAD"]);
}

export async function writeGraphMeta(connection: Connection, meta: GraphMeta) {
  const statement = await connection.prepare(
    "MERGE (m:GraphMeta {key: $key}) SET m.value = $value",
  );

  const entries: [string, string][] = [
    ["seededAt", meta.seededAt],
    ["commit", meta.commit],
    ["tsconfigs", JSON.stringify(meta.tsconfigs)],
    ["counts", JSON.stringify(meta.counts)],
  ];

  for (const [key, value] of entries) {
    const result = singleResult(await connection.execute(statement, { key, value }));
    await result.close();
  }
}

// Returns undefined when no complete metadata is recorded — either the
// GraphMeta table doesn't exist yet (a graph seeded before this feature, or
// one whose seeding crashed before the table was created), or it exists but
// a seed never finished writing all four keys into it (e.g. seeding crashed
// partway through). Both are "we don't know", never silently "fresh".
export async function readGraphMeta(connection: Connection): Promise<GraphMeta | undefined> {
  let rows: Record<string, unknown>[];

  try {
    const result = singleResult(await connection.query("MATCH (m:GraphMeta) RETURN m.key AS key, m.value AS value"));
    rows = await result.getAll();
    await result.close();
  } catch {
    // Binder exception: Table GraphMeta does not exist.
    return undefined;
  }

  const values = new Map(rows.map((row) => [row.key as string, row.value as string]));

  if (!REQUIRED_KEYS.every((key) => values.has(key))) {
    return undefined;
  }

  return {
    seededAt: values.get("seededAt")!,
    commit: values.get("commit")!,
    tsconfigs: JSON.parse(values.get("tsconfigs")!) as string[],
    counts: JSON.parse(values.get("counts")!) as SeedSummary,
  };
}

export async function describeFreshness(
  connection: Connection,
  databasePath: string,
  projectRoot: string,
): Promise<FreshnessReport> {
  const meta = await readGraphMeta(connection);
  const now = await currentCommit(projectRoot);

  if (!meta) {
    return {
      databasePath,
      ageMinutes: -1,
      currentCommit: now,
      changedFiles: [],
      stale: true,
      reason: "Grafen saknar seedningsmetadata (tabellen GraphMeta saknas eller är ofullständig) — kör 'codegraph seed' för att seeda om.",
      seededAt: null,
      commit: null,
      tsconfigs: null,
      counts: null,
    };
  }

  // Files changed since seeding: both committed changes and the working tree.
  const committed = meta.commit && now && meta.commit !== now
    ? await git(projectRoot, ["diff", "--name-only", meta.commit, now])
    : "";
  const working = await git(projectRoot, ["status", "--porcelain"]);
  const changedFiles = [
    ...committed.split("\n").filter(Boolean),
    ...working.split("\n").filter(Boolean).map((line) => line.slice(3)),
  ];
  const unique = [...new Set(changedFiles)].filter((file) => /\.tsx?$/.test(file)).sort();

  const seededAtMs = Date.parse(meta.seededAt);

  return {
    seededAt: meta.seededAt,
    commit: meta.commit,
    tsconfigs: meta.tsconfigs,
    counts: meta.counts,
    databasePath,
    ageMinutes: Number.isNaN(seededAtMs) ? -1 : Math.round((Date.now() - seededAtMs) / 60000),
    currentCommit: now,
    changedFiles: unique,
    stale: unique.length > 0,
  };
}
