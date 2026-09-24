import type { Pool, PoolClient } from "pg";

/** Bound acquisition and SQL together, destroying a busy connection on abort. */
export function withAccountMailClient<T>(
  pool: Pool,
  signal: AbortSignal | undefined,
  action: (client: PoolClient, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const deadline = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  return new Promise<T>((resolve, reject) => {
    let client: PoolClient | undefined;
    let finished = false;
    const timer = setTimeout(() => deadline.abort(), 10_000);
    const finish = (error: unknown, value?: T) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
      // Destroying the connection cancels the server statement. Never return
      // an aborted client's connection to the pool while its query is running.
      client?.release(Boolean(error));
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new Error("account_mail_database_cancelled"));
    combined.addEventListener("abort", abort, { once: true });
    if (combined.aborted) {
      abort();
      return;
    }
    void pool.connect().then((acquired) => {
      if (finished) {
        acquired.release(true);
        return;
      }
      client = acquired;
      try {
        void action(acquired, combined).then(
          (value) => finish(null, value),
          finish
        );
      } catch (error) {
        finish(error);
      }
    }, finish);
  });
}
