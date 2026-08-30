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

// The MCP SDK dispatches tool calls without awaiting the previous one to
// finish (see protocol.js's fire-and-forget `Promise.resolve().then(...)`
// dispatch), so two withConnection calls can be in flight together. Kuzu's
// close() does not coordinate with an outstanding query, so without
// serializing, one call detecting a reseed could close the shared connection
// while another call is still mid-query against it — a closed-handle crash
// instead of a clean result. Every call queues behind the previous one; a
// warm query costs ~0.5ms, so serializing costs nothing that matters. The
// queue tail always advances once a turn settles, fulfilled or rejected, so
// one failing call can never wedge every later call — but each call still
// returns (and rejects with) its own outcome, unswallowed.
let queueTail: Promise<void> = Promise.resolve();

export function withConnection<T>(
  databasePath: string,
  run: (connection: Connection) => Promise<T>,
): Promise<T> {
  const turn = queueTail.then(() => runWithCachedConnection(databasePath, run));
  queueTail = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

// Opening a 26 MB Kuzu file costs ~37ms; a stat costs microseconds.
// Kuzu takes no exclusive lock, so the seeder can write while the server is
// alive — but an open connection then keeps serving the OLD graph without
// throwing. Inode and mtime are what reveal that the seeder swapped the file.
async function runWithCachedConnection<T>(
  databasePath: string,
  run: (connection: Connection) => Promise<T>,
): Promise<T> {
  const stats = statDatabaseFile(databasePath);

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

// statSync throws (e.g. ENOENT) when the database file doesn't exist right
// now — the seeder removes the old file before the new one exists, so a call
// can land in that window. Surface a Swedish, user-facing message instead of
// a raw fs error, matching getDatabasePath()'s style above.
function statDatabaseFile(databasePath: string) {
  try {
    return statSync(databasePath);
  } catch {
    throw new Error("Grafen seedas om just nu, försök igen om en stund.");
  }
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
export interface ResolutionCounts {
  unresolvedImports: number | null;
  unresolvedMocks: number | null;
  // Calls leaving the seeded projects (node_modules, the TypeScript lib).
  // Expected, and no reflection on graph quality — kept apart from
  // unresolvedCalls so a large number here cannot be misread as a large gap.
  externalCalls: number | null;
  unresolvedCalls: number | null;
}

export interface NeighborResult {
  nodes: SymbolMatch[];
  counts: Record<string, ResolutionCounts>;
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

// Columns this branch added to the schema (line ranges in 2fa664a, unresolved
// counters in bd737f9). A Kuzu binder exception naming exactly one of these
// means the open database predates those migrations — e.g. a graph seeded
// before this feature existed and never re-seeded — not a genuine bug. Any
// other binder exception (a typo'd table name, a column that was never part
// of this list) does not match and is rethrown unchanged, as itself.
const SCHEMA_ADDITIONS_ON_THIS_BRANCH = new Set([
  "line",
  "endLine",
  "unresolvedImports",
  "unresolvedMocks",
  "externalCalls",
  "unresolvedCalls",
]);

export const STALE_SCHEMA_MESSAGE =
  "Grafen verkar vara byggd med en äldre version av CodeGraph — kör 'codegraph seed' för att bygga om den.";

// Narrowly discriminates "old-schema database" from a real bug: only a Kuzu
// binder exception of the exact shape "Cannot find property <X> for ..." where
// <X> is one of this branch's own added columns is relabelled. Anything else —
// a different binder exception, a non-Error throw, a property name we don't
// recognize — is rethrown exactly as received.
export function rethrowFriendlyIfStaleSchema(error: unknown): never {
  if (error instanceof Error) {
    const match = /^Binder exception: Cannot find property (\w+) for /.exec(error.message);
    if (match && SCHEMA_ADDITIONS_ON_THIS_BRANCH.has(match[1])) {
      throw new Error(STALE_SCHEMA_MESSAGE);
    }
  }

  throw error;
}

// Searches both name and path across all three node types. File has no
// name/kind/line and is therefore normalized to fileName and null respectively.
//
// Matching is a case-insensitive substring test. Case-sensitivity was the
// single biggest source of false empty results: a caller searching "party"
// found partyTools but not createParty, and read that as "the graph doesn't
// know about parties" rather than "P is not p". Lowercasing both sides costs
// a scan we were doing anyway.
export async function findSymbol(connection: Connection, query: string): Promise<SymbolMatch[]> {
  const matches: SymbolMatch[] = [];
  const needle = query.toLowerCase();

  try {
    const fileRows = await rows(
      connection,
      `MATCH (n:File) WHERE lower(n.path) CONTAINS $query OR lower(n.fileName) CONTAINS $query
       RETURN n.path AS path, n.fileName AS name ORDER BY path`,
      { query: needle },
    );
    for (const row of fileRows) {
      matches.push({ nodeType: "File", path: row.path as string, name: row.name as string, kind: "file", line: null, endLine: null });
    }

    for (const table of ["Type", "Function"] as const) {
      const nodeRows = await rows(
        connection,
        `MATCH (n:${table}) WHERE lower(n.path) CONTAINS $query OR lower(n.name) CONTAINS $query
         RETURN n.path AS path, n.name AS name, n.kind AS kind, n.line AS line, n.endLine AS endLine
         ORDER BY path`,
        { query: needle },
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
  } catch (error) {
    rethrowFriendlyIfStaleSchema(error);
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
  try {
    return await queryNeighborsUnguarded(connection, query);
  } catch (error) {
    rethrowFriendlyIfStaleSchema(error);
  }
}

async function queryNeighborsUnguarded(connection: Connection, query: NeighborQuery): Promise<NeighborResult> {
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

  // What the query's starting nodes could NOT resolve, and what they resolved
  // to something outside the graph. Without these, an empty node list is
  // indistinguishable from a list that failed to build.
  const counts: NeighborResult["counts"] = {};
  const knownPaths = new Set<string>();

  const fileCounts = await rows(
    connection,
    `MATCH (f:File) WHERE list_contains($paths, f.path)
     RETURN f.path AS path, f.unresolvedImports AS imports, f.unresolvedMocks AS mocks`,
    { paths: query.paths },
  );

  // The file-level call counters are real rollups, not fabricated 0s: each sums
  // over every function the file owns directly (HAS_FUNCTION) and every method
  // owned by a type the file declares (DECLARES -> HAS_METHOD). Methods are
  // included deliberately — a file's call debt is the debt of everything
  // defined in it, not just its top-level functions. A file with no functions
  // or methods legitimately sums to 0 (a measured empty sum, not a guess), so
  // these fields are always numbers for File, never null.
  const ownFunctionCalls = await rows(
    connection,
    `MATCH (f:File)-[:HAS_FUNCTION]->(fn:Function) WHERE list_contains($paths, f.path)
     RETURN f.path AS path, sum(fn.externalCalls) AS external, sum(fn.unresolvedCalls) AS unresolved`,
    { paths: query.paths },
  );
  const methodCalls = await rows(
    connection,
    `MATCH (f:File)-[:DECLARES]->(:Type)-[:HAS_METHOD]->(m:Function) WHERE list_contains($paths, f.path)
     RETURN f.path AS path, sum(m.externalCalls) AS external, sum(m.unresolvedCalls) AS unresolved`,
    { paths: query.paths },
  );
  const externalRollup = new Map<string, number>();
  const unresolvedRollup = new Map<string, number>();
  for (const row of [...ownFunctionCalls, ...methodCalls]) {
    const path = row.path as string;
    externalRollup.set(path, (externalRollup.get(path) ?? 0) + Number(row.external as bigint));
    unresolvedRollup.set(path, (unresolvedRollup.get(path) ?? 0) + Number(row.unresolved as bigint));
  }

  for (const row of fileCounts) {
    const path = row.path as string;
    knownPaths.add(path);
    counts[path] = {
      unresolvedImports: row.imports as number,
      unresolvedMocks: row.mocks as number,
      externalCalls: externalRollup.get(path) ?? 0,
      unresolvedCalls: unresolvedRollup.get(path) ?? 0,
    };
  }

  const functionCounts = await rows(
    connection,
    `MATCH (fn:Function) WHERE list_contains($paths, fn.path)
     RETURN fn.path AS path, fn.externalCalls AS external, fn.unresolvedCalls AS unresolved`,
    { paths: query.paths },
  );
  for (const row of functionCounts) {
    const path = row.path as string;
    knownPaths.add(path);
    counts[path] = {
      // A Function has no imports or mocks of its own; null, not a fabricated 0.
      unresolvedImports: null,
      unresolvedMocks: null,
      externalCalls: row.external as number,
      unresolvedCalls: row.unresolved as number,
    };
  }

  // Types carry none of these counters, but a path matching a Type node
  // is still a known path — it must not be reported as unknown below.
  const typeRows = await rows(
    connection,
    `MATCH (t:Type) WHERE list_contains($paths, t.path) RETURN t.path AS path`,
    { paths: query.paths },
  );
  for (const row of typeRows) {
    const path = row.path as string;
    knownPaths.add(path);
    counts[path] = { unresolvedImports: null, unresolvedMocks: null, externalCalls: null, unresolvedCalls: null };
  }

  // A requested path that backs no node at all (typo, stale reference, path from
  // a different tsconfig project) is neither in counts nor found among nodes.
  // Without unknownPaths that silently looks identical to "found, no neighbours".
  const unknownPaths = query.paths.filter((path) => !knownPaths.has(path));

  return { nodes: [...seen.values()], counts, unknownPaths };
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
      "Expanderar en eller flera noder längs valda kanttyper och returnerar grannarna med radintervall. edges: IMPORTS, MOCKS, CALLS, DECLARES, HAS_FUNCTION, HAS_METHOD. direction 'in' besvarar 'vem anropar/importerar/mockar detta'. Svaret innehåller alltid counts per sökväg: null betyder att räknaren inte är tillämplig för den nodtypen, ett tal betyder att den faktiskt mättes (även om värdet är 0). externalCalls räknar anrop som lämnar de seedade projekten (node_modules, TypeScripts lib) — förväntat och inget tecken på att grafen är bristfällig. unresolvedCalls/unresolvedImports/unresolvedMocks räknar det grafen faktiskt missade: en tom nodlista med en sådan räknare > 0 betyder att relationen inte kunde upplösas, inte att den saknas. unknownPaths listar sökvägar som inte matchar någon nod alls.",
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
  async () => {
    const databasePath = getDatabasePath();
    return withConnection(databasePath, async (connection) => {
      const report = await describeFreshness(connection, databasePath, path.dirname(path.dirname(databasePath)));
      return textResult(JSON.stringify(report, null, 2));
    });
  },
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
