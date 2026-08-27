import { rm } from "node:fs/promises";
import path from "node:path";
import { Project } from "ts-morph";
import {
  closeGraphDatabase,
  createGraphDatabase,
  DEFAULT_DATABASE_PATH,
  singleResult,
} from "./schema.js";

export interface SeedSummary {
  files: number;
  imports: number;
  unresolvedImports: number;
}

export async function seedCodebase(
  tsconfigPath: string,
  databasePath = DEFAULT_DATABASE_PATH,
): Promise<SeedSummary> {
  const resolvedTsconfigPath = path.resolve(tsconfigPath);
  const resolvedDatabasePath = path.resolve(databasePath);
  const project = new Project({ tsConfigFilePath: resolvedTsconfigPath });
  const sourceFiles = project.getSourceFiles();
  const projectFilePaths = new Set(sourceFiles.map((sourceFile) => sourceFile.getFilePath()));

  await rm(resolvedDatabasePath, { force: true, recursive: true });

  const { database, connection } = await createGraphDatabase(resolvedDatabasePath);

  try {
    const insertFile = await connection.prepare("MERGE (file:File {path: $path})");
    const insertImport = await connection.prepare(`
      MATCH (source:File {path: $sourcePath}), (target:File {path: $targetPath})
      MERGE (source)-[:IMPORTS]->(target)
    `);

    for (const sourceFile of sourceFiles) {
      const result = singleResult(await connection.execute(insertFile, { path: sourceFile.getFilePath() }));
      await result.close();
    }

    let imports = 0;
    let unresolvedImports = 0;

    for (const sourceFile of sourceFiles) {
      for (const declaration of sourceFile.getImportDeclarations()) {
        const targetFile = declaration.getModuleSpecifierSourceFile();

        if (!targetFile || !projectFilePaths.has(targetFile.getFilePath())) {
          unresolvedImports += 1;
          continue;
        }

        const result = singleResult(await connection.execute(insertImport, {
          sourcePath: sourceFile.getFilePath(),
          targetPath: targetFile.getFilePath(),
        }));
        await result.close();
        imports += 1;
      }
    }

    return { files: sourceFiles.length, imports, unresolvedImports };
  } finally {
    await closeGraphDatabase(database, connection);
  }
}

function getTsconfigPath(argumentsList: string[]) {
  const optionIndex = argumentsList.indexOf("--tsconfig");

  if (optionIndex === -1 || !argumentsList[optionIndex + 1]) {
    throw new Error("Missing --tsconfig <path>.");
  }

  return argumentsList[optionIndex + 1];
}

async function main() {
  const tsconfigPath = getTsconfigPath(process.argv.slice(2));
  const summary = await seedCodebase(tsconfigPath);

  console.log(
    `Seeded ${summary.files} files and ${summary.imports} imports (${summary.unresolvedImports} unresolved imports).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}