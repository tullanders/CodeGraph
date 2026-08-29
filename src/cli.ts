import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTsconfigPaths, writeTsconfigPaths } from "./config.js";
import { findGraphDatabase, graphDatabasePathFor } from "./paths.js";
import { seedCodebase } from "./seed.js";

const projectRoot = process.cwd();
const tsconfigPath = path.join(projectRoot, "tsconfig.json");
// init always creates the graph in the directory the command is run from —
// that's the explicit installation gesture. seed reuses an existing graph
// wherever it lives upward, so seeding from a subdirectory in a monorepo
// doesn't create a second, competing graph.
const initDatabasePath = graphDatabasePathFor(projectRoot);
const seedDatabasePath = findGraphDatabase(projectRoot) ?? initDatabasePath;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpServerPath = path.join(packageRoot, "src", "mcp-server.ts");
const tsxPath = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");

async function requireTsconfigs(tsconfigPaths: string[]) {
  for (const tsconfigPath of tsconfigPaths) {
    try {
      await access(tsconfigPath);
    } catch {
      throw new Error(`Hittar ingen tsconfig.json på ${tsconfigPath}.`);
    }
  }
}

// --tsconfig can be repeated: codegraph init --tsconfig tsconfig.json --tsconfig packages/pdf/tsconfig.json
function parseTsconfigFlags(argumentsList: string[]): string[] {
  const paths: string[] = [];

  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] !== "--tsconfig") {
      continue;
    }

    const value = argumentsList[index + 1];

    if (!value) {
      throw new Error("--tsconfig kräver en sökväg.");
    }

    paths.push(path.resolve(projectRoot, value));
  }

  return paths;
}

async function ensureGitignore() {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  let contents = "";

  try {
    contents = await readFile(gitignorePath, "utf8");
  } catch {
  }

  if (!/(^|\n)\.codegraph\/(?:\n|$)/.test(contents)) {
    const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    await appendFile(gitignorePath, `${separator}.codegraph/\n`);
    console.log(`La till .codegraph/ i ${gitignorePath}`);
  }
}

async function ensureMcpConfiguration() {
  const mcpConfigPath = path.join(projectRoot, ".mcp.json");
  let configuration: { mcpServers?: Record<string, unknown> } = {};

  try {
    configuration = JSON.parse(await readFile(mcpConfigPath, "utf8")) as typeof configuration;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Kunde inte lasa ${mcpConfigPath}. Kontrollera att filen innehaller giltig JSON.`);
    }
  }

  configuration.mcpServers ??= {};
  configuration.mcpServers.codegraph = {
    type: "stdio",
    // Bare "node" avoids baking in the absolute node path of whichever
    // shell happened to run "codegraph init", which can vary between
    // terminals/version managers on the same machine.
    command: "node",
    args: [tsxPath, mcpServerPath],
    cwd: projectRoot,
  };

  await writeFile(mcpConfigPath, `${JSON.stringify(configuration, null, 2)}\n`);
  console.log(`Konfigurerade CodeGraph i ${mcpConfigPath}`);
}

async function seed(databasePath: string, tsconfigPaths: string[]) {
  await requireTsconfigs(tsconfigPaths);
  const summary = await seedCodebase(tsconfigPaths, databasePath);
  console.log(
    `Seeded ${summary.files} files, ${summary.types} types, ${summary.functions} functions, and ${summary.imports} imports (${summary.unresolvedImports} unresolved imports). ${summary.calls} calls resolved (${summary.unresolvedCalls} unresolved calls). ${summary.mocks} mocks resolved (${summary.unresolvedMocks} unresolved mocks).`,
  );
  console.log(`Grafen ligger i ${databasePath}`);
}

async function init(tsconfigPaths: string[]) {
  const resolved = tsconfigPaths.length > 0 ? tsconfigPaths : [tsconfigPath];
  await requireTsconfigs(resolved);
  await ensureGitignore();
  await ensureMcpConfiguration();
  await writeTsconfigPaths(projectRoot, resolved);
  await seed(initDatabasePath, resolved);
  console.log(`CodeGraph ar installerat i ${projectRoot}.`);
}

async function main() {
  const command = process.argv[2];
  const flagged = parseTsconfigFlags(process.argv.slice(3));

  if (command === "init") {
    await init(flagged);
    return;
  }

  if (command === "seed") {
    const tsconfigPaths = flagged.length > 0 ? flagged : await readTsconfigPaths(projectRoot);
    await seed(seedDatabasePath, tsconfigPaths);
    return;
  }

  throw new Error("Använd: codegraph init [--tsconfig <sökväg>]... eller codegraph seed [--tsconfig <sökväg>]...");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
