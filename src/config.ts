import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { GRAPH_DIRECTORY } from "./paths.js";

interface CodeGraphConfig {
  tsconfigs: string[];
}

function configPathFor(projectRoot: string) {
  return path.join(path.resolve(projectRoot), GRAPH_DIRECTORY, "config.json");
}

// Paths are stored relative to the project root so .codegraph/config.json can
// be checked in and shared across a team without carrying anyone's home directory.
export async function readTsconfigPaths(projectRoot: string): Promise<string[]> {
  const configPath = configPathFor(projectRoot);

  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as CodeGraphConfig;

    if (!Array.isArray(config.tsconfigs) || config.tsconfigs.length === 0) {
      throw new Error(`${configPath} saknar en icke-tom "tsconfigs"-lista.`);
    }

    return config.tsconfigs.map((entry) => path.resolve(projectRoot, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [path.join(path.resolve(projectRoot), "tsconfig.json")];
    }

    throw error;
  }
}

export async function writeTsconfigPaths(projectRoot: string, tsconfigPaths: string[]) {
  const configPath = configPathFor(projectRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  const config: CodeGraphConfig = {
    tsconfigs: tsconfigPaths.map((entry) => path.relative(path.resolve(projectRoot), path.resolve(entry))),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

// How many directory levels below the project root the scan descends. A
// monorepo keeps its packages at apps/<name>/ or packages/<name>/, so three is
// enough to find them while keeping init cheap on a large tree.
const MAX_SCAN_DEPTH = 3;

// Every tsconfig.json in the project that the given list does not already
// cover. Seeding one tsconfig in a monorepo silently leaves whole packages out
// of the graph, and the expensive failure mode is a reader searching a package
// that was never indexed and taking the empty result as "this code does not
// exist". Knowing what was left out is what makes that recoverable.
//
// node_modules and dot-directories are skipped: a dependency's own tsconfig and
// a worktree copy would both seed files nobody edits here.
export async function findAdditionalTsconfigs(projectRoot: string, chosen: string[]): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const already = new Set(chosen.map((entry) => path.resolve(entry)));
  const found: string[] = [];

  async function walk(directory: string, depth: number) {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is not worth failing init over — the whole
      // point of this scan is a suggestion, not a guarantee.
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);

      // isDirectory() is false for a symlink, so the walk cannot loop.
      if (entry.isDirectory()) {
        if (depth >= MAX_SCAN_DEPTH || entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }

        await walk(fullPath, depth + 1);
        continue;
      }

      if (entry.name === "tsconfig.json" && !already.has(fullPath)) {
        found.push(fullPath);
      }
    }
  }

  await walk(root, 0);

  return found.sort();
}
