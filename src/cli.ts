import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedCodebase } from "./seed.js";

const projectRoot = process.cwd();
const tsconfigPath = path.join(projectRoot, "tsconfig.json");
const databasePath = path.join(projectRoot, ".codegraph", "kuzu");
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpServerPath = path.join(packageRoot, "src", "mcp-server.ts");
const tsxPath = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");

async function requireTsconfig() {
  try {
    await access(tsconfigPath);
  } catch {
    throw new Error(`Hittar ingen tsconfig.json i ${projectRoot}. Kör kommandot från projektets rot.`);
  }
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

async function seed() {
  await requireTsconfig();
  const summary = await seedCodebase(tsconfigPath, databasePath);
  console.log(
    `Seeded ${summary.files} files, ${summary.types} types, ${summary.functions} functions, and ${summary.imports} imports (${summary.unresolvedImports} unresolved imports). ${summary.calls} calls resolved (${summary.unresolvedCalls} unresolved calls). ${summary.mocks} mocks resolved (${summary.unresolvedMocks} unresolved mocks).`,
  );
}

async function init() {
  await requireTsconfig();
  await ensureGitignore();
  await ensureMcpConfiguration();
  await seed();
  console.log(`CodeGraph ar installerat i ${projectRoot}.`);
}

async function main() {
  const command = process.argv[2];

  if (command === "init") {
    await init();
    return;
  }

  if (command === "seed") {
    await seed();
    return;
  }

  throw new Error("Använd: codegraph init eller codegraph seed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
