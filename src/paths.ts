import { existsSync } from "node:fs";
import path from "node:path";

export const GRAPH_DIRECTORY = ".codegraph";
export const GRAPH_FILE = "kuzu";

// Sökvägen en graf SKULLE ha i den här katalogen. Kräver inte att den finns.
export function graphDatabasePathFor(directory: string): string {
  return path.join(path.resolve(directory), GRAPH_DIRECTORY, GRAPH_FILE);
}

// Letar uppåt efter en befintlig graf, som git letar efter .git. Närmast vinner.
// Detta är den enda regeln för var grafen ligger — CLI, seeder och MCP-server
// delar den, annars skriver den ena dit den andra inte läser.
export function findGraphDatabase(startDirectory: string): string | undefined {
  for (const directory of searchedDirectories(startDirectory)) {
    const candidate = graphDatabasePathFor(directory);

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

// Katalogkedjan från startDirectory upp till filsystemsroten, för felmeddelanden.
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
