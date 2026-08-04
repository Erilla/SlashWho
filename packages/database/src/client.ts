import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(client: Pool | PoolClient): Database {
  return drizzle(client, { schema });
}
