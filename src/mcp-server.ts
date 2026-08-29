import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Connection, Database, KuzuValue } from "kuzu";
import path from "node:path";
import { z } from "zod";
import { describeFreshness } from "./graph-meta.js";
import { findGraphDatabase, searchedDirectories } from "./paths.js";
import { openGraphDatabase, singleResult } from "./schema.js";

function getDatabasePath() {
  const databasePath = findGraphDatabase(process.cwd());

  if (!databasePath) {
    const searched = searchedDirectories(process.cwd())
      .map((directory) => `- ${directory}`)
      .join("\n");
    throw new Error(
      `Ingen graf hittades. Sökte efter .codegraph/kuzu i:\n${searched}\nKör 'codegraph init' i projektets rot.`,
    );
  }

  return databasePath;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function withConnection<T>(databasePath: string, run: (connection: Connection) => Promise<T>): Promise<T> {
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

const NODE_TABLES = ["File", "Type", "Function"] as const;
const EDGE_TYPES = ["IMPORTS", "MOCKS", "CALLS", "DECLARES", "HAS_FUNCTION", "HAS_METHOD"] as const;
type EdgeType = (typeof EDGE_TYPES)[number];

export interface SymbolMatch {
  nodeType: (typeof NODE_TABLES)[number];
  path: string;
  name: string;
  kind: string;
  line: number | null;
  endLine: number | null;
}

export interface NeighborQuery {
  paths: string[];
  edges: EdgeType[];
  direction: "out" | "in" | "both";
  depth: number;
}

export interface NeighborResult {
  nodes: SymbolMatch[];
  unresolved: Record<string, { unresolvedImports: number; unresolvedMocks: number; unresolvedCalls: number }>;
}

async function rows(connection: Connection, statement: string, parameters: Record<string, KuzuValue>) {
  const prepared = await connection.prepare(statement);
  const result = singleResult(await connection.execute(prepared, parameters));
  const all = await result.getAll();
  await result.close();
  return all;
}

// Searches both name and path across all three node types. File has no
// name/kind/line and is therefore normalized to fileName and null respectively.
export async function findSymbol(connection: Connection, query: string): Promise<SymbolMatch[]> {
  const matches: SymbolMatch[] = [];

  const fileRows = await rows(
    connection,
    `MATCH (n:File) WHERE n.path CONTAINS $query OR n.fileName CONTAINS $query
     RETURN n.path AS path, n.fileName AS name ORDER BY path`,
    { query },
  );
  for (const row of fileRows) {
    matches.push({ nodeType: "File", path: row.path as string, name: row.name as string, kind: "file", line: null, endLine: null });
  }

  for (const table of ["Type", "Function"] as const) {
    const nodeRows = await rows(
      connection,
      `MATCH (n:${table}) WHERE n.path CONTAINS $query OR n.name CONTAINS $query
       RETURN n.path AS path, n.name AS name, n.kind AS kind, n.line AS line, n.endLine AS endLine
       ORDER BY path`,
      { query },
    );
    for (const row of nodeRows) {
      matches.push({
        nodeType: table,
        path: row.path as string,
        name: row.name as string,
        kind: row.kind as string,
        line: row.line as number,
        endLine: row.endLine as number,
      });
    }
  }

  return matches;
}

// Edge and direction names are interpolated, but they come exclusively from
// EDGE_TYPES and a Zod enum in the tool schema below — never from a free
// string field. The path list is bound as a parameter.
export async function queryNeighbors(connection: Connection, query: NeighborQuery): Promise<NeighborResult> {
  const seen = new Map<string, SymbolMatch>();
  const depth = Math.min(Math.max(query.depth, 1), 3);

  for (const edge of query.edges) {
    if (!EDGE_TYPES.includes(edge)) {
      throw new Error(`Okänd kanttyp: ${edge}`);
    }

    const patterns =
      query.direction === "both"
        ? [`-[:${edge}*1..${depth}]->`, `<-[:${edge}*1..${depth}]-`]
        : query.direction === "out"
          ? [`-[:${edge}*1..${depth}]->`]
          : [`<-[:${edge}*1..${depth}]-`];

    for (const pattern of patterns) {
      for (const table of NODE_TABLES) {
        const nameExpression = table === "File" ? "target.fileName" : "target.name";
        const kindExpression = table === "File" ? "'file'" : "target.kind";
        const lineExpression = table === "File" ? "NULL" : "target.line";
        const endLineExpression = table === "File" ? "NULL" : "target.endLine";

        let found: Record<string, unknown>[];
        try {
          found = await rows(
            connection,
            `MATCH (source)${pattern}(target:${table})
             WHERE list_contains($paths, source.path)
             RETURN DISTINCT target.path AS path, ${nameExpression} AS name, ${kindExpression} AS kind,
                    ${lineExpression} AS line, ${endLineExpression} AS endLine
             ORDER BY path`,
            { paths: query.paths },
          );
        } catch {
          // The edge type cannot reach this node table; skip it.
          continue;
        }

        for (const row of found) {
          const key = `${table}:${row.path as string}`;
          if (!seen.has(key)) {
            seen.set(key, {
              nodeType: table,
              path: row.path as string,
              name: row.name as string,
              kind: row.kind as string,
              line: (row.line as number | null) ?? null,
              endLine: (row.endLine as number | null) ?? null,
            });
          }
        }
      }
    }
  }

  // What the query's starting nodes could NOT resolve. Without this, an
  // empty node list is indistinguishable from a list that failed to build.
  const unresolved: NeighborResult["unresolved"] = {};

  const fileCounts = await rows(
    connection,
    `MATCH (f:File) WHERE list_contains($paths, f.path)
     RETURN f.path AS path, f.unresolvedImports AS imports, f.unresolvedMocks AS mocks`,
    { paths: query.paths },
  );
  for (const row of fileCounts) {
    unresolved[row.path as string] = {
      unresolvedImports: row.imports as number,
      unresolvedMocks: row.mocks as number,
      unresolvedCalls: 0,
    };
  }

  const functionCounts = await rows(
    connection,
    `MATCH (fn:Function) WHERE list_contains($paths, fn.path)
     RETURN fn.path AS path, fn.unresolvedCalls AS calls`,
    { paths: query.paths },
  );
  for (const row of functionCounts) {
    unresolved[row.path as string] = {
      unresolvedImports: 0,
      unresolvedMocks: 0,
      unresolvedCalls: row.calls as number,
    };
  }

  return { nodes: [...seen.values()], unresolved };
}

const server = new McpServer({ name: "codegraph", version: "0.1.0" });

server.registerTool(
  "find_symbol",
  {
    description:
      "Hittar filer, typer och funktioner vars namn eller sökväg innehåller söksträngen. Returnerar sökväg och radintervall, så att du kan läsa exakt rätt rader i stället för hela filen. Börja här i stället för att grepa efter ett namn.",
    inputSchema: { query: z.string().min(1) },
  },
  async ({ query }) =>
    withConnection(getDatabasePath(), async (connection) => {
      const matches = await findSymbol(connection, query);

      if (matches.length === 0) {
        return textResult(
          `Inget matchar "${query}". Grafen innehåller bara de tsconfig-projekt som seedades — kör graph_status för att se vilka.`,
        );
      }

      return textResult(JSON.stringify(matches, null, 2));
    }),
);

server.registerTool(
  "neighbors",
  {
    description:
      "Expanderar en eller flera noder längs valda kanttyper och returnerar grannarna med radintervall. edges: IMPORTS, MOCKS, CALLS, DECLARES, HAS_FUNCTION, HAS_METHOD. direction 'in' besvarar 'vem anropar/importerar/mockar detta'. Svaret innehåller alltid unresolved-räknare: en tom nodlista med unresolved > 0 betyder att grafen inte kunde upplösa relationen, inte att den saknas.",
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).max(50),
      edges: z.array(z.enum(EDGE_TYPES)).min(1),
      direction: z.enum(["out", "in", "both"]).default("out"),
      depth: z.number().int().min(1).max(3).default(1),
    },
  },
  async ({ paths, edges, direction, depth }) =>
    withConnection(getDatabasePath(), async (connection) => {
      const result = await queryNeighbors(connection, { paths, edges, direction, depth });
      return textResult(JSON.stringify(result, null, 2));
    }),
);

server.registerTool(
  "graph_status",
  {
    description:
      "Returnerar grafens färskhet: när den seedades, mot vilken commit, vilka tsconfig som ingick, hur många TypeScript-filer som ändrats sedan dess, och var databasen ligger. Anropa detta innan du litar på ett radintervall från grafen.",
    inputSchema: {},
  },
  async () =>
    withConnection(getDatabasePath(), async (connection) => {
      const databasePath = getDatabasePath();
      const report = await describeFreshness(connection, databasePath, path.dirname(path.dirname(databasePath)));
      return textResult(JSON.stringify(report, null, 2));
    }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codegraph MCP-server startad over stdio.");
}

// Only start the transport when this file runs as a program, not when a test imports it.
if (process.argv[1] && process.argv[1].endsWith("mcp-server.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
