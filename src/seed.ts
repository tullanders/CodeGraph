import { rm } from "node:fs/promises";
import path from "node:path";
import { FunctionDeclaration, MethodDeclaration, Project, SourceFile, SyntaxKind, ts } from "ts-morph";
import { closeGraphDatabase, createGraphDatabase, singleResult } from "./schema.js";

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
  tsconfigPaths: string[],
  databasePath: string,
): Promise<SeedSummary> {
  if (tsconfigPaths.length === 0) {
    throw new Error("Minst en tsconfig.json måste anges.");
  }

  const resolvedDatabasePath = path.resolve(databasePath);
  const projects = tsconfigPaths.map((tsconfigPath) => {
    const resolvedTsconfigPath = path.resolve(tsconfigPath);
    return {
      project: new Project({ tsConfigFilePath: resolvedTsconfigPath }),
      projectRoot: path.dirname(resolvedTsconfigPath),
    };
  });

  // A file can be part of several projects. Deduplicate by path so that
  // every file is visited exactly once, otherwise its imports and functions
  // would be double-counted.
  const sourceFileByPath = new Map<string, SourceFile>();

  for (const { project, projectRoot } of projects) {
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();

      if (isInHiddenRootDirectory(filePath, projectRoot)) {
        continue;
      }

      if (!sourceFileByPath.has(filePath)) {
        sourceFileByPath.set(filePath, sourceFile);
      }
    }
  }

  const sourceFiles = [...sourceFileByPath.values()];
  // The union across all projects. Resolving imports against this set — and
  // not against one project at a time — is the whole point: it's how an
  // import from apps/web to packages/core becomes an edge instead of an
  // unresolved counter.
  const projectFilePaths = new Set(sourceFileByPath.keys());

  // Each file must be resolved with its own project's compiler options.
  const projectByFilePath = new Map<string, (typeof projects)[number]["project"]>();

  for (const { project } of projects) {
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();

      if (!projectByFilePath.has(filePath)) {
        projectByFilePath.set(filePath, project);
      }
    }
  }

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
      MERGE (type:Type {path: $typePath, name: $name, kind: $kind, line: $line, endLine: $endLine})
      MERGE (file)-[:DECLARES]->(type)
    `);
    const insertFunction = await connection.prepare(`
      MATCH (file:File {path: $filePath})
      MERGE (fn:Function {path: $fnPath, name: $name, kind: $kind, line: $line, endLine: $endLine})
      MERGE (file)-[:HAS_FUNCTION]->(fn)
    `);
    const insertMethod = await connection.prepare(`
      MATCH (type:Type {path: $typePath})
      MERGE (fn:Function {path: $fnPath, name: $name, kind: $kind, line: $line, endLine: $endLine})
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

    for (const sourceFile of sourceFiles) {
      for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const moduleSpecifier = getMockModuleSpecifier(callExpression);

        if (!moduleSpecifier) {
          continue;
        }

        const owningProject = projectByFilePath.get(sourceFile.getFilePath());

        if (!owningProject) {
          unresolvedMocks += 1;
          continue;
        }

        const resolution = ts.resolveModuleName(
          moduleSpecifier,
          sourceFile.getFilePath(),
          owningProject.getCompilerOptions(),
          owningProject.getModuleResolutionHost(),
        );
        const resolvedPath = resolution.resolvedModule
          ? owningProject.getSourceFile(resolution.resolvedModule.resolvedFileName)?.getFilePath()
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
        ...sourceFile.getClasses().map((declaration) => ({ declaration, name: declaration.getName(), kind: "class" })),
        ...sourceFile.getInterfaces().map((declaration) => ({ declaration, name: declaration.getName(), kind: "interface" })),
        ...sourceFile.getTypeAliases().map((declaration) => ({ declaration, name: declaration.getName(), kind: "typeAlias" })),
      ];

      for (const { declaration, name, kind } of declarations) {
        if (!name) {
          continue;
        }

        const result = singleResult(await connection.execute(insertType, {
          filePath,
          typePath: `${filePath}:${name}`,
          name,
          kind,
          line: declaration.getStartLineNumber(),
          endLine: declaration.getEndLineNumber(),
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
          line: declaration.getStartLineNumber(),
          endLine: declaration.getEndLineNumber(),
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
            line: method.getStartLineNumber(),
            endLine: method.getEndLineNumber(),
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
