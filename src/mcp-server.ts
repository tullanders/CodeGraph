import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Connection, Database, KuzuValue } from "kuzu";
import { statSync } from "node:fs";
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

interface CachedConnection {
  databasePath: string;
  inode: number;
  modifiedMs: number;
  database: Database;
  connection: Connection;
}

let cached: CachedConnection | undefined;

// Opening a 26 MB Kuzu file costs ~37ms; a stat costs microseconds.
// Kuzu takes no exclusive lock, so the seeder can write while the server is
// alive — but an open connection then keeps serving the OLD graph without
// throwing. Inode and mtime are what reveal that the seeder swapped the file.
export async function withConnection<T>(
  databasePath: string,
  run: (connection: Connection) => Promise<T>,
): Promise<T> {
  const stats = statSync(databasePath);

  if (
    cached &&
    cached.databasePath === databasePath &&
    cached.inode === stats.ino &&
    cached.modifiedMs === stats.mtimeMs
  ) {
    return run(cached.connection);
  }

  await closeCachedConnection();
  const { database, connection } = openGraphDatabase(databasePath);
  cached = { databasePath, inode: stats.ino, modifiedMs: stats.mtimeMs, database, connection };

  return run(connection);
}

export async function closeCachedConnection() {
  if (!cached) {
    return;
  }

  const { database, connection } = cached;
  cached = undefined;
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

// null means the counter does not apply to that node type (e.g. a Function has
// no unresolvedImports of its own); a number means it was actually measured,
// even when that measurement is 0. Never fabricate a 0 for an inapplicable field.
export interface UnresolvedCounts {
  unresolvedImports: number | null;
  unresolvedMocks: number | null;
  unresolvedCalls: number | null;
}

export interface NeighborResult {
  nodes: SymbolMatch[];
  unresolved: Record<string, UnresolvedCounts>;
  // Requested paths that back no node at all (File, Type, or Function) — distinct
  // from a path that resolved to a node with no neighbours or no unresolved debt.
  unknownPaths: string[];
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

// Every relation table's endpoint types, taken from schema.ts's CREATE REL TABLE
// statements. This is the single source of truth for which (edge, direction) pairs
// can legally reach which node table, so the query loop below never has to guess
// and probe — it only ever issues queries the schema actually supports.
const EDGE_SCHEMA: Record<EdgeType, { from: (typeof NODE_TABLES)[number]; to: (typeof NODE_TABLES)[number] }> = {
  IMPORTS: { from: "File", to: "File" },
  MOCKS: { from: "File", to: "File" },
  DECLARES: { from: "File", to: "Type" },
  HAS_FUNCTION: { from: "File", to: "Function" },
  HAS_METHOD: { from: "Type", to: "Function" },
  CALLS: { from: "Function", to: "Function" },
};

const DIRECTIONS = ["out", "in", "both"] as const;

// Rejects non-integer, non-finite, or out-of-range depths at the queryNeighbors
// boundary itself. The registered tool's Zod schema (.int().min(1).max(3)) already
// enforces this over stdio, but queryNeighbors is also exported and called directly
// (see test/tools-smoke.ts), so it needs its own guard rather than silently
// clamping a bad value (e.g. 2.5 or NaN) into something that looks legitimate.
function normalizeDepth(depth: number): number {
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
    throw new Error(`Ogiltigt djup: ${depth}. Måste vara ett heltal 1-3.`);
  }
  return depth;
}

// Edge and direction names are interpolated, but they come exclusively from
// EDGE_TYPES/DIRECTIONS and Zod enums in the tool schema below — never from a
// free string field. The path list is bound as a parameter.
export async function queryNeighbors(connection: Connection, query: NeighborQuery): Promise<NeighborResult> {
  const seen = new Map<string, SymbolMatch>();
  const depth = normalizeDepth(query.depth);

  if (!DIRECTIONS.includes(query.direction)) {
    throw new Error(`Okänd riktning: ${query.direction}`);
  }

  for (const edge of query.edges) {
    if (!EDGE_TYPES.includes(edge)) {
      throw new Error(`Okänd kanttyp: ${edge}`);
    }

    const schema = EDGE_SCHEMA[edge];
    // out: source -[edge]-> target, so target belongs to schema.to.
    // in:  target -[edge]-> source (written as source <-[edge]- target), so
    //      target belongs to schema.from.
    const legs: { pattern: string; table: (typeof NODE_TABLES)[number] }[] = [];
    if (query.direction === "out" || query.direction === "both") {
      legs.push({ pattern: `-[:${edge}*1..${depth}]->`, table: schema.to });
    }
    if (query.direction === "in" || query.direction === "both") {
      legs.push({ pattern: `<-[:${edge}*1..${depth}]-`, table: schema.from });
    }

    for (const { pattern, table } of legs) {
      const nameExpression = table === "File" ? "target.fileName" : "target.name";
      const kindExpression = table === "File" ? "'file'" : "target.kind";
      const lineExpression = table === "File" ? "NULL" : "target.line";
      const endLineExpression = table === "File" ? "NULL" : "target.endLine";

      const found = await rows(
        connection,
        `MATCH (source)${pattern}(target:${table})
         WHERE list_contains($paths, source.path)
         RETURN DISTINCT target.path AS path, ${nameExpression} AS name, ${kindExpression} AS kind,
                ${lineExpression} AS line, ${endLineExpression} AS endLine
         ORDER BY path`,
        { paths: query.paths },
      );

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

  // What the query's starting nodes could NOT resolve. Without this, an
  // empty node list is indistinguishable from a list that failed to build.
  const unresolved: NeighborResult["unresolved"] = {};
  const knownPaths = new Set<string>();

  const fileCounts = await rows(
    connection,
    `MATCH (f:File) WHERE list_contains($paths, f.path)
     RETURN f.path AS path, f.unresolvedImports AS imports, f.unresolvedMocks AS mocks`,
    { paths: query.paths },
  );

  // File-level unresolvedCalls is a real rollup, not a fabricated 0: it sums
  // unresolvedCalls over every function the file owns directly (HAS_FUNCTION)
  // and every method owned by a type the file declares (DECLARES -> HAS_METHOD).
  // Methods are included deliberately — a file's outstanding call debt is the
  // debt of everything defined in it, not just its top-level functions. A file
  // with no functions or methods legitimately sums to 0 (a measured empty sum,
  // not a guess), so this field is always a number for File, never null.
  const ownFunctionCalls = await rows(
    connection,
    `MATCH (f:File)-[:HAS_FUNCTION]->(fn:Function) WHERE list_contains($paths, f.path)
     RETURN f.path AS path, sum(fn.unresolvedCalls) AS calls`,
    { paths: query.paths },
  );
  const methodCalls = await rows(
    connection,
    `MATCH (f:File)-[:DECLARES]->(:Type)-[:HAS_METHOD]->(m:Function) WHERE list_contains($paths, f.path)
     RETURN f.path AS path, sum(m.unresolvedCalls) AS calls`,
    { paths: query.paths },
  );
  const fileCallRollup = new Map<string, number>();
  for (const row of [...ownFunctionCalls, ...methodCalls]) {
    const path = row.path as string;
    fileCallRollup.set(path, (fileCallRollup.get(path) ?? 0) + Number(row.calls as bigint));
  }

  for (const row of fileCounts) {
    const path = row.path as string;
    knownPaths.add(path);
    unresolved[path] = {
      unresolvedImports: row.imports as number,
      unresolvedMocks: row.mocks as number,
      unresolvedCalls: fileCallRollup.get(path) ?? 0,
    };
  }

  const functionCounts = await rows(
    connection,
    `MATCH (fn:Function) WHERE list_contains($paths, fn.path)
     RETURN fn.path AS path, fn.unresolvedCalls AS calls`,
    { paths: query.paths },
  );
  for (const row of functionCounts) {
    const path = row.path as string;
    knownPaths.add(path);
    unresolved[path] = {
      // A Function has no imports or mocks of its own; null, not a fabricated 0.
      unresolvedImports: null,
      unresolvedMocks: null,
      unresolvedCalls: row.calls as number,
    };
  }

  // Types carry none of these three counters, but a path matching a Type node
  // is still a known path — it must not be reported as unknown below.
  const typeRows = await rows(
    connection,
    `MATCH (t:Type) WHERE list_contains($paths, t.path) RETURN t.path AS path`,
    { paths: query.paths },
  );
  for (const row of typeRows) {
    const path = row.path as string;
    knownPaths.add(path);
    unresolved[path] = { unresolvedImports: null, unresolvedMocks: null, unresolvedCalls: null };
  }

  // A requested path that backs no node at all (typo, stale reference, path from
  // a different tsconfig project) is neither in unresolved nor found among nodes.
  // Without unknownPaths that silently looks identical to "found, no neighbours".
  const unknownPaths = query.paths.filter((path) => !knownPaths.has(path));

  return { nodes: [...seen.values()], unresolved, unknownPaths };
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
      "Expanderar en eller flera noder längs valda kanttyper och returnerar grannarna med radintervall. edges: IMPORTS, MOCKS, CALLS, DECLARES, HAS_FUNCTION, HAS_METHOD. direction 'in' besvarar 'vem anropar/importerar/mockar detta'. Svaret innehåller alltid unresolved-räknare per sökväg: null betyder att räknaren inte är tillämplig för den nodtypen, ett tal betyder att den faktiskt mättes (även om värdet är 0) — en tom nodlista med en mätt räknare > 0 betyder att grafen inte kunde upplösa relationen, inte att den saknas. unknownPaths listar sökvägar som inte matchar någon nod alls.",
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

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void closeCachedConnection().finally(() => process.exit(0));
    });
  }
}

// Only start the transport when this file runs as a program, not when a test imports it.
if (process.argv[1] && process.argv[1].endsWith("mcp-server.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
