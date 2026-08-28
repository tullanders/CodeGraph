import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Connection, Database } from "kuzu";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { openGraphDatabase, singleResult } from "./schema.js";

const pathQueryShape = { pathQuery: z.string().min(1) };

function getDatabasePath() {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return path.resolve(projectRoot, ".codegraph/kuzu");
}

function requireDatabase(databasePath: string) {
  if (!existsSync(databasePath)) {
    throw new Error("Ingen graf hittades. Kor 'npm run seed' forst.");
  }
}

async function findMatchingFiles(connection: Connection, pathQuery: string): Promise<string[]> {
  const statement = await connection.prepare(
    "MATCH (file:File) WHERE file.path CONTAINS $pathQuery RETURN file.path AS path ORDER BY file.path",
  );
  const result = singleResult(await connection.execute(statement, { pathQuery }));
  const rows = await result.getAll();
  await result.close();
  return rows.map((row) => row.path as string);
}

async function findRelatedFiles(
  connection: Connection,
  filePath: string,
  relationship: "IMPORTS" | "MOCKS",
  direction: "outgoing" | "incoming",
): Promise<string[]> {
  const statement =
    direction === "outgoing"
      ? await connection.prepare(
          `MATCH (:File {path: $filePath})-[:${relationship}]->(target:File) RETURN target.path AS path ORDER BY target.path`,
        )
      : await connection.prepare(
          `MATCH (source:File)-[:${relationship}]->(:File {path: $filePath}) RETURN source.path AS path ORDER BY source.path`,
        );
  const result = singleResult(await connection.execute(statement, { filePath }));
  const rows = await result.getAll();
  await result.close();
  return rows.map((row) => row.path as string);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function resolveFileQuery(
  connection: Connection,
  pathQuery: string,
  relationship: "IMPORTS" | "MOCKS",
  direction: "outgoing" | "incoming",
  resultKey: string,
) {
  const matches = await findMatchingFiles(connection, pathQuery);

  if (matches.length === 0) {
    return textResult(`Ingen fil matchar "${pathQuery}".`);
  }

  if (matches.length > 1) {
    const candidates = matches.map((match) => `- ${match}`).join("\n");
    return textResult(`Flera filer matchar "${pathQuery}", forsok igen med en mer specifik sokvag:\n${candidates}`);
  }

  const [filePath] = matches;
  const related = await findRelatedFiles(connection, filePath, relationship, direction);
  return textResult(JSON.stringify({ path: filePath, [resultKey]: related }, null, 2));
}

async function withConnection<T>(databasePath: string, run: (connection: Connection) => Promise<T>): Promise<T> {
  requireDatabase(databasePath);
  const { database, connection } = openGraphDatabase(databasePath);

  try {
    return await run(connection);
  } finally {
    await closeDatabase(database, connection);
  }
}

async function closeDatabase(database: Database, connection: Connection) {
  await connection.close();
  await database.close();
}

const server = new McpServer({ name: "codegraph", version: "0.1.0" });

server.registerTool(
  "get_file_dependencies",
  {
    description: "Returnerar de filer som en given fil importerar direkt.",
    inputSchema: pathQueryShape,
  },
  async ({ pathQuery }) =>
    withConnection(getDatabasePath(), (connection) =>
      resolveFileQuery(connection, pathQuery, "IMPORTS", "outgoing", "dependencies"),
    ),
);

server.registerTool(
  "get_file_importers",
  {
    description: "Returnerar de filer som direkt importerar en given fil.",
    inputSchema: pathQueryShape,
  },
  async ({ pathQuery }) =>
    withConnection(getDatabasePath(), (connection) =>
      resolveFileQuery(connection, pathQuery, "IMPORTS", "incoming", "importers"),
    ),
);

server.registerTool(
  "get_file_mocks",
  {
    description: "Returnerar de moduler som en given fil mockar (t.ex. via vi.mock/jest.mock).",
    inputSchema: pathQueryShape,
  },
  async ({ pathQuery }) =>
    withConnection(getDatabasePath(), (connection) =>
      resolveFileQuery(connection, pathQuery, "MOCKS", "outgoing", "mocks"),
    ),
);

server.registerTool(
  "get_file_mocked_by",
  {
    description: "Returnerar de filer som mockar en given fil (t.ex. via vi.mock/jest.mock).",
    inputSchema: pathQueryShape,
  },
  async ({ pathQuery }) =>
    withConnection(getDatabasePath(), (connection) =>
      resolveFileQuery(connection, pathQuery, "MOCKS", "incoming", "mockedBy"),
    ),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codegraph MCP-server startad over stdio.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
