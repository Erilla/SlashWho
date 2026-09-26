import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * Runs `work` in one transaction on a dedicated client: COMMIT when it
 * returns, ROLLBACK when it throws, and the client back to the pool either
 * way. Returning early is how a transaction ends early, so nothing inside
 * `work` issues COMMIT or ROLLBACK itself.
 */
export function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  return transaction(pool, "BEGIN", work);
}

/**
 * Runs several reads against one snapshot of the database. Under the default
 * READ COMMITTED each statement sees whatever had committed when it started,
 * so a write landing between two reads can make them disagree.
 */
export function withConsistentRead<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  return transaction(
    pool,
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    work
  );
}

async function transaction<T>(
  pool: Pool,
  begin: string,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // A failed ROLLBACK must not mask the error that caused it.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The first row of a query that always returns one: an aggregate, an
 * `INSERT … RETURNING`, or a row the caller has just locked. An empty result
 * throws a named error instead of handing `undefined` on as a row.
 */
export function one<Row extends QueryResultRow>(
  result: QueryResult<Row>,
  name = "expected_row_missing"
): Row {
  const row = result.rows[0];
  if (row === undefined) throw new Error(name);
  return row;
}
