import { rm } from "node:fs/promises";
import path from "node:path";
import { CallExpression, Node, Project, SourceFile, SyntaxKind, ts } from "ts-morph";
import { currentCommit, writeGraphMeta } from "./graph-meta.js";
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
  // Calls whose callee is declared outside the seeded file set — node_modules,
  // the TypeScript lib, another project. Expected and unfixable: a graph of
  // these tsconfig projects cannot contain those nodes. Reported so the number
  // is visible, never as a defect.
  externalCalls: number;
  // Calls the seeder genuinely could not place: no symbol at all (a call
  // through `any`), or a callee declared inside the seeded files that we do
  // not index as a Function node. This is the only call counter that says
  // anything about graph quality.
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
  await rm(`${resolvedDatabasePath}.wal`, { force: true });

  const { database, connection } = await createGraphDatabase(resolvedDatabasePath);

  try {
    const insertFile = await connection.prepare(
      "MERGE (file:File {path: $path, fileName: $fileName, unresolvedImports: 0, unresolvedMocks: 0})",
    );
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
      MERGE (fn:Function {path: $fnPath, name: $name, kind: $kind, line: $line, endLine: $endLine, externalCalls: 0, unresolvedCalls: 0})
      MERGE (file)-[:HAS_FUNCTION]->(fn)
    `);
    const insertMethod = await connection.prepare(`
      MATCH (type:Type {path: $typePath})
      MERGE (fn:Function {path: $fnPath, name: $name, kind: $kind, line: $line, endLine: $endLine, externalCalls: 0, unresolvedCalls: 0})
      MERGE (type)-[:HAS_METHOD]->(fn)
    `);
    const insertCall = await connection.prepare(`
      MATCH (caller:Function {path: $callerPath}), (callee:Function {path: $calleePath})
      MERGE (caller)-[:CALLS]->(callee)
    `);
    const setFileUnresolved = await connection.prepare(`
      MATCH (file:File {path: $path})
      SET file.unresolvedImports = $unresolvedImports, file.unresolvedMocks = $unresolvedMocks
    `);
    const setFunctionUnresolved = await connection.prepare(`
      MATCH (fn:Function {path: $path})
      SET fn.externalCalls = $externalCalls, fn.unresolvedCalls = $unresolvedCalls
    `);

    for (const sourceFile of sourceFiles) {
      const result = singleResult(await connection.execute(insertFile, { path: sourceFile.getFilePath(), fileName: sourceFile.getBaseName() }));
      await result.close();
    }

    // Per node, not just in aggregate: the query layer must be able to say "this
    // file has 2 unresolved imports" so a genuinely empty list can be told apart
    // from one that could not be built.
    const unresolvedImportsByFile = new Map<string, number>();
    const unresolvedMocksByFile = new Map<string, number>();
    const externalCallsByFunction = new Map<string, number>();
    const unresolvedCallsByFunction = new Map<string, number>();

    let imports = 0;
    let unresolvedImports = 0;

    for (const sourceFile of sourceFiles) {
      for (const declaration of sourceFile.getImportDeclarations()) {
        const targetFile = declaration.getModuleSpecifierSourceFile();

        if (!targetFile || !projectFilePaths.has(targetFile.getFilePath())) {
          const filePath = sourceFile.getFilePath();
          unresolvedImportsByFile.set(filePath, (unresolvedImportsByFile.get(filePath) ?? 0) + 1);
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
          const filePath = sourceFile.getFilePath();
          unresolvedMocksByFile.set(filePath, (unresolvedMocksByFile.get(filePath) ?? 0) + 1);
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
          const filePath = sourceFile.getFilePath();
          unresolvedMocksByFile.set(filePath, (unresolvedMocksByFile.get(filePath) ?? 0) + 1);
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

    // Maps the declaration node a call site resolves to onto its Function node,
    // plus the body to scan for outgoing calls. Keyed by declaration because
    // that is what the type checker hands back for a callee — for an arrow
    // function bound to a const, that is the VariableDeclaration, not the
    // arrow itself, so the arrow can never be the key.
    const indexedFunctions = new Map<Node, { path: string; body: Node | undefined }>();
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
        indexedFunctions.set(declaration, { path: fnPath, body: declaration.getBody() });
        functions += 1;
      }

      // `export const handler = () => {}` is a function in every sense that
      // matters here, and in a lot of TypeScript it is the dominant style.
      // Leaving these out cost twice: the callee was missing, so every call to
      // it counted as a miss, and the calls inside its own body were never
      // scanned at all. kind stays "function" — how the function got its name
      // is not something a caller navigating the graph should have to branch on.
      for (const declaration of sourceFile.getVariableDeclarations()) {
        const initializer = declaration.getInitializer();

        if (!initializer?.isKind(SyntaxKind.ArrowFunction) && !initializer?.isKind(SyntaxKind.FunctionExpression)) {
          continue;
        }

        const name = declaration.getName();
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
        indexedFunctions.set(declaration, { path: fnPath, body: initializer.getBody() });
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
          indexedFunctions.set(method, { path: fnPath, body: method.getBody() });
          functions += 1;
        }
      }
    }

    let calls = 0;
    let externalCalls = 0;
    let unresolvedCalls = 0;

    for (const { path: callerPath, body } of indexedFunctions.values()) {
      if (!body) {
        continue;
      }

      for (const callExpression of callExpressionsIn(body)) {
        const symbol = callExpression.getExpression().getSymbol();
        const resolvedSymbol = symbol?.getAliasedSymbol() ?? symbol;
        // getValueDeclaration() is empty for anything declared only as a type
        // — the fluent builder methods of a query library, for instance, whose
        // .d.ts carries method signatures and no implementation. Falling back
        // to the first declaration is what lets those be recognized as
        // external rather than counted as our own failure to resolve them.
        const targetDeclaration = resolvedSymbol?.getValueDeclaration() ?? resolvedSymbol?.getDeclarations()[0];
        const calleePath = targetDeclaration ? indexedFunctions.get(targetDeclaration)?.path : undefined;

        if (!calleePath) {
          // Three outcomes, only the last of which is a defect: the callee is
          // declared outside the seeded files (external), or we could not
          // place it at all — no declaration, or one inside the seeded files
          // that we do not index as a Function node (unresolved).
          const isExternal =
            targetDeclaration !== undefined &&
            !projectFilePaths.has(targetDeclaration.getSourceFile().getFilePath());

          if (isExternal) {
            externalCallsByFunction.set(callerPath, (externalCallsByFunction.get(callerPath) ?? 0) + 1);
            externalCalls += 1;
          } else {
            unresolvedCallsByFunction.set(callerPath, (unresolvedCallsByFunction.get(callerPath) ?? 0) + 1);
            unresolvedCalls += 1;
          }

          continue;
        }

        const result = singleResult(await connection.execute(insertCall, { callerPath, calleePath }));
        await result.close();
        calls += 1;
      }
    }

    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.getFilePath();
      const result = singleResult(await connection.execute(setFileUnresolved, {
        path: filePath,
        unresolvedImports: unresolvedImportsByFile.get(filePath) ?? 0,
        unresolvedMocks: unresolvedMocksByFile.get(filePath) ?? 0,
      }));
      await result.close();
    }

    for (const { path: functionPath } of indexedFunctions.values()) {
      const result = singleResult(await connection.execute(setFunctionUnresolved, {
        path: functionPath,
        externalCalls: externalCallsByFunction.get(functionPath) ?? 0,
        unresolvedCalls: unresolvedCallsByFunction.get(functionPath) ?? 0,
      }));
      await result.close();
    }

    const summary: SeedSummary = {
      files: sourceFiles.length,
      imports,
      unresolvedImports,
      mocks,
      unresolvedMocks,
      types,
      functions,
      calls,
      externalCalls,
      unresolvedCalls,
    };

    await writeGraphMeta(connection, {
      seededAt: new Date().toISOString(),
      commit: await currentCommit(path.dirname(resolvedDatabasePath)),
      tsconfigs: tsconfigPaths.map((entry) => path.resolve(entry)),
      counts: summary,
    });

    return summary;
  } finally {
    await closeGraphDatabase(database, connection);
  }
}

// A concise arrow body — `const f = (value) => value.trim()` — IS the call
// expression rather than a block containing one, so scanning descendants alone
// would silently miss every call in that very common shape.
function callExpressionsIn(body: Node): CallExpression[] {
  const nested = body.getDescendantsOfKind(SyntaxKind.CallExpression);

  return body.isKind(SyntaxKind.CallExpression) ? [body, ...nested] : nested;
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
