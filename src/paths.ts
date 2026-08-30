import { existsSync } from "node:fs";
import path from "node:path";

export const GRAPH_DIRECTORY = ".codegraph";
export const GRAPH_FILE = "kuzu";

// The path a graph WOULD have in this directory. Does not require it to exist.
export function graphDatabasePathFor(directory: string): string {
  return path.join(path.resolve(directory), GRAPH_DIRECTORY, GRAPH_FILE);
}

// Searches upward for an existing graph, like git searches for .git. Nearest wins.
// This is the single rule for where the graph lives — CLI, seeder and MCP server
// all share it, otherwise one writes where the other doesn't read.
export function findGraphDatabase(startDirectory: string): string | undefined {
  for (const directory of searchedDirectories(startDirectory)) {
    const candidate = graphDatabasePathFor(directory);

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

// The chain of directories from startDirectory up to the filesystem root, for error messages.
export function searchedDirectories(startDirectory: string): string[] {
  const directories: string[] = [];
  let directory = path.resolve(startDirectory);

  while (true) {
    directories.push(directory);
    const parent = path.dirname(directory);

    if (parent === directory) {
      return directories;
    }

    directory = parent;
  }
}
