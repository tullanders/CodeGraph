import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connection } from "kuzu";
import { singleResult } from "./schema.js";
import type { SeedSummary } from "./seed.js";

const run = promisify(execFile);

export interface GraphMeta {
  seededAt: string;
  commit: string;
  tsconfigs: string[];
  counts: SeedSummary;
}

export interface FreshnessReport extends GraphMeta {
  databasePath: string;
  ageMinutes: number;
  currentCommit: string;
  changedFiles: string[];
  stale: boolean;
}

// Empty value when the directory isn't a git repo — freshness should degrade,
// not throw.
async function git(projectRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: projectRoot });
    return stdout.trim();
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

export async function readGraphMeta(connection: Connection): Promise<GraphMeta> {
  const result = singleResult(await connection.query("MATCH (m:GraphMeta) RETURN m.key AS key, m.value AS value"));
  const rows = await result.getAll();
  await result.close();

  const values = new Map(rows.map((row) => [row.key as string, row.value as string]));

  return {
    seededAt: values.get("seededAt") ?? "",
    commit: values.get("commit") ?? "",
    tsconfigs: JSON.parse(values.get("tsconfigs") ?? "[]") as string[],
    counts: JSON.parse(values.get("counts") ?? "{}") as SeedSummary,
  };
}

export async function describeFreshness(
  connection: Connection,
  databasePath: string,
  projectRoot: string,
): Promise<FreshnessReport> {
  const meta = await readGraphMeta(connection);
  const now = await currentCommit(projectRoot);

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
    ...meta,
    databasePath,
    ageMinutes: Number.isNaN(seededAtMs) ? -1 : Math.round((Date.now() - seededAtMs) / 60000),
    currentCommit: now,
    changedFiles: unique,
    stale: unique.length > 0,
  };
}
