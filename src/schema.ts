import { Connection, Database, QueryResult } from "kuzu";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DATABASE_PATH = path.resolve(".codegraph/kuzu");

export async function createGraphDatabase(databasePath = DEFAULT_DATABASE_PATH) {
  await mkdir(path.dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  const connection = new Connection(database);

  await execute(connection, "CREATE NODE TABLE File(path STRING, fileName STRING, PRIMARY KEY (path));");
  await execute(connection, "CREATE REL TABLE IMPORTS(FROM File TO File);");
  await execute(connection, "CREATE REL TABLE MOCKS(FROM File TO File);");
  await execute(connection, "CREATE NODE TABLE Type(path STRING, name STRING, kind STRING, line INT64, endLine INT64, PRIMARY KEY (path));");
  await execute(connection, "CREATE REL TABLE DECLARES(FROM File TO Type);");
  await execute(connection, "CREATE NODE TABLE Function(path STRING, name STRING, kind STRING, line INT64, endLine INT64, PRIMARY KEY (path));");
  await execute(connection, "CREATE REL TABLE HAS_FUNCTION(FROM File TO Function);");
  await execute(connection, "CREATE REL TABLE HAS_METHOD(FROM Type TO Function);");
  await execute(connection, "CREATE REL TABLE CALLS(FROM Function TO Function);");

  return { database, connection };
}

export function openGraphDatabase(databasePath = DEFAULT_DATABASE_PATH) {
  const database = new Database(databasePath);
  const connection = new Connection(database);

  return { database, connection };
}

export async function execute(connection: Connection, statement: string) {
  const result = singleResult(await connection.query(statement));
  await result.close();
}

export function singleResult(result: QueryResult | QueryResult[]) {
  if (Array.isArray(result)) {
    if (result.length !== 1) {
      throw new Error(`Expected one query result but received ${result.length}.`);
    }

    return result[0];
  }

  return result;
}

export async function closeGraphDatabase(database: Database, connection: Connection) {
  await connection.close();
  await database.close();
}