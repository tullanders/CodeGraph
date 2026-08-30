import { readFile, writeFile, mkdir } from "node:fs/promises";
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
