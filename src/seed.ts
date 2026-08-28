import { rm } from "node:fs/promises";
import path from "node:path";
import { FunctionDeclaration, MethodDeclaration, Project, SyntaxKind, ts } from "ts-morph";
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
  mocks: number;
  unresolvedMocks: number;
  types: number;
  functions: number;
  calls: number;
  unresolvedCalls: number;
}

const MOCK_FUNCTION_NAMES = new Set(["mock", "doMock"]);
const MOCK_OBJECT_NAMES = new Set(["vi", "jest"]);

export async function seedCodebase(
  tsconfigPath: string,
  databasePath?: string,
): Promise<SeedSummary> {
  const resolvedTsconfigPath = path.resolve(tsconfigPath);
  const resolvedDatabasePath = path.resolve(
    databasePath ?? path.join(path.dirname(resolvedTsconfigPath), ".codegraph/kuzu"),
  );
  const project = new Project({ tsConfigFilePath: resolvedTsconfigPath });
  const projectRoot = path.dirname(resolvedTsconfigPath);
  const sourceFiles = project
    .getSourceFiles()
    .filter((sourceFile) => !isInHiddenRootDirectory(sourceFile.getFilePath(), projectRoot));
  const projectFilePaths = new Set(sourceFiles.map((sourceFile) => sourceFile.getFilePath()));

  await rm(resolvedDatabasePath, { force: true, recursive: true });

  const { database, connection } = await createGraphDatabase(resolvedDatabasePath);

  try {
    const insertFile = await connection.prepare("MERGE (file:File {path: $path, fileName: $fileName})");
    const insertImport = await connection.prepare(`
      MATCH (source:File {path: $sourcePath}), (target:File {path: $targetPath})
      MERGE (source)-[:IMPORTS]->(target)
    `);
    const insertMock = await connection.prepare(`
      MATCH (source:File {path: $sourcePath}), (target:File {path: $targetPath})
      MERGE (source)-[:MOCKS]->(target)
    `);
    const insertType = await connection.prepare(`
      MATCH (file:File {path: $filePath})
      MERGE (type:Type {path: $typePath, name: $name, kind: $kind})
      MERGE (file)-[:DECLARES]->(type)
    `);
    const insertFunction = await connection.prepare(`
      MATCH (file:File {path: $filePath})
      MERGE (fn:Function {path: $fnPath, name: $name, kind: $kind})
      MERGE (file)-[:HAS_FUNCTION]->(fn)
    `);
    const insertMethod = await connection.prepare(`
      MATCH (type:Type {path: $typePath})
      MERGE (fn:Function {path: $fnPath, name: $name, kind: $kind})
      MERGE (type)-[:HAS_METHOD]->(fn)
    `);
    const insertCall = await connection.prepare(`
      MATCH (caller:Function {path: $callerPath}), (callee:Function {path: $calleePath})
      MERGE (caller)-[:CALLS]->(callee)
    `);

    for (const sourceFile of sourceFiles) {
      const result = singleResult(await connection.execute(insertFile, { path: sourceFile.getFilePath(), fileName: sourceFile.getBaseName() }));
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

    let mocks = 0;
    let unresolvedMocks = 0;
    const compilerOptions = project.getCompilerOptions();
    const moduleResolutionHost = project.getModuleResolutionHost();

    for (const sourceFile of sourceFiles) {
      for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const moduleSpecifier = getMockModuleSpecifier(callExpression);

        if (!moduleSpecifier) {
          continue;
        }

        const resolution = ts.resolveModuleName(
          moduleSpecifier,
          sourceFile.getFilePath(),
          compilerOptions,
          moduleResolutionHost,
        );
        const resolvedPath = resolution.resolvedModule
          ? project.getSourceFile(resolution.resolvedModule.resolvedFileName)?.getFilePath()
          : undefined;

        if (!resolvedPath || !projectFilePaths.has(resolvedPath)) {
          unresolvedMocks += 1;
          continue;
        }

        const result = singleResult(await connection.execute(insertMock, {
          sourcePath: sourceFile.getFilePath(),
          targetPath: resolvedPath,
        }));
        await result.close();
        mocks += 1;
      }
    }

    let types = 0;

    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.getFilePath();
      const declarations = [
        ...sourceFile.getClasses().map((declaration) => ({ name: declaration.getName(), kind: "class" })),
        ...sourceFile.getInterfaces().map((declaration) => ({ name: declaration.getName(), kind: "interface" })),
      ];

      for (const { name, kind } of declarations) {
        if (!name) {
          continue;
        }

        const result = singleResult(await connection.execute(insertType, {
          filePath,
          typePath: `${filePath}:${name}`,
          name,
          kind,
        }));
        await result.close();
        types += 1;
      }
    }

    // Maps a function/method declaration node to its Function node path, so call sites can be resolved.
    const functionPathByDeclaration = new Map<FunctionDeclaration | MethodDeclaration, string>();
    let functions = 0;

    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.getFilePath();

      for (const declaration of sourceFile.getFunctions()) {
        const name = declaration.getName();

        if (!name) {
          continue;
        }

        const fnPath = `${filePath}:${name}`;
        const result = singleResult(await connection.execute(insertFunction, {
          filePath,
          fnPath,
          name,
          kind: "function",
        }));
        await result.close();
        functionPathByDeclaration.set(declaration, fnPath);
        functions += 1;
      }

      for (const classDeclaration of sourceFile.getClasses()) {
        const className = classDeclaration.getName();

        if (!className) {
          continue;
        }

        const typePath = `${filePath}:${className}`;

        for (const method of classDeclaration.getMethods()) {
          const name = method.getName();
          const fnPath = `${typePath}.${name}`;
          const result = singleResult(await connection.execute(insertMethod, {
            typePath,
            fnPath,
            name,
            kind: "method",
          }));
          await result.close();
          functionPathByDeclaration.set(method, fnPath);
          functions += 1;
        }
      }
    }

    let calls = 0;
    let unresolvedCalls = 0;

    for (const [declaration, callerPath] of functionPathByDeclaration) {
      const body = declaration.getBody();

      if (!body) {
        continue;
      }

      for (const callExpression of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const symbol = callExpression.getExpression().getSymbol();
        const resolvedSymbol = symbol?.getAliasedSymbol() ?? symbol;
        const targetDeclaration = resolvedSymbol?.getValueDeclaration();
        const calleePath = targetDeclaration ? functionPathByDeclaration.get(
          targetDeclaration as FunctionDeclaration | MethodDeclaration,
        ) : undefined;

        if (!calleePath) {
          unresolvedCalls += 1;
          continue;
        }

        const result = singleResult(await connection.execute(insertCall, { callerPath, calleePath }));
        await result.close();
        calls += 1;
      }
    }

    return {
      files: sourceFiles.length,
      imports,
      unresolvedImports,
      mocks,
      unresolvedMocks,
      types,
      functions,
      calls,
      unresolvedCalls,
    };
  } finally {
    await closeGraphDatabase(database, connection);
  }
}

// Recognizes vi.mock("...")/jest.mock("...") (and doMock variants) with a static string module specifier.
function getMockModuleSpecifier(callExpression: import("ts-morph").CallExpression): string | undefined {
  const expression = callExpression.getExpression();

  if (!expression.isKind(SyntaxKind.PropertyAccessExpression)) {
    return undefined;
  }

  const object = expression.getExpression();
  const isMockCall =
    object.isKind(SyntaxKind.Identifier) &&
    MOCK_OBJECT_NAMES.has(object.getText()) &&
    MOCK_FUNCTION_NAMES.has(expression.getName());

  if (!isMockCall) {
    return undefined;
  }

  const [firstArgument] = callExpression.getArguments();

  if (!firstArgument || !firstArgument.isKind(SyntaxKind.StringLiteral)) {
    return undefined;
  }

  return firstArgument.getLiteralText();
}

function isInHiddenRootDirectory(filePath: string, projectRoot: string) {
  const [rootDirectory] = path.relative(projectRoot, filePath).split(path.sep);

  return rootDirectory.startsWith(".");
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
    `Seeded ${summary.files} files, ${summary.types} types, ${summary.functions} functions, and ${summary.imports} imports (${summary.unresolvedImports} unresolved imports). ${summary.calls} calls resolved (${summary.unresolvedCalls} unresolved calls). ${summary.mocks} mocks resolved (${summary.unresolvedMocks} unresolved mocks).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}