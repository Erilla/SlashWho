import { createConnection, createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

/**
 * A TCP proxy that adds a fixed round trip to every connection through it.
 * The dossier load profiler (#685) puts it between the web server and
 * PostgreSQL, so a local run pays a database round trip like Railway's.
 *
 * Two things made the first attempts in #666 wrong by an order of magnitude:
 * Nagle's algorithm holding back the small protocol messages, so both
 * sockets set `noDelay`; and `setTimeout`, which on Windows rounds up to the
 * ~15.6 ms system timer. Chunks are instead queued with a due time from
 * `performance.now()` and released from a `setImmediate` loop that runs only
 * while something is queued.
 */
export type LatencyProxy = Readonly<{
  host: string;
  port: number;
  close(): Promise<void>;
}>;

/**
 * `PROFILE_DB_RTT_MS`: absent or empty means no proxy at all. Anything else
 * must be a finite, non-negative number of milliseconds, so a typo fails the
 * run rather than quietly measuring without latency.
 */
export function parseRoundTripMs(
  value: string | undefined
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const roundTripMs = Number(value);
  if (!Number.isFinite(roundTripMs) || roundTripMs < 0) {
    throw new Error("profile_db_rtt_ms_invalid");
  }
  return roundTripMs;
}

type DelayLine = Readonly<{
  push(deliver: () => void): void;
  clear(): void;
}>;

/** One direction of one connection: first in, first out, each held `delayMs`. */
function createDelayLine(delayMs: number): DelayLine {
  const queue: { dueAt: number; deliver: () => void }[] = [];
  let pumping = false;
  const pump = () => {
    const now = performance.now();
    while (queue.length > 0 && queue[0]!.dueAt <= now) queue.shift()!.deliver();
    if (queue.length > 0) setImmediate(pump);
    else pumping = false;
  };
  return {
    push(deliver) {
      queue.push({ dueAt: performance.now() + delayMs, deliver });
      if (!pumping) {
        pumping = true;
        setImmediate(pump);
      }
    },
    clear() {
      queue.length = 0;
    }
  };
}

/** Relays `source` to `destination`, `end` included, through a delay line. */
function relay(
  source: Socket,
  destination: Socket,
  delayMs: number
): DelayLine {
  const line = createDelayLine(delayMs);
  source.on("data", (chunk: Buffer) => {
    line.push(() => {
      if (!destination.destroyed) destination.write(chunk);
    });
  });
  // Through the same queue, so the end can never overtake the data before it.
  source.on("end", () => {
    line.push(() => {
      if (!destination.destroyed) destination.end();
    });
  });
  return line;
}

export async function startLatencyProxy(options: {
  target: { host: string; port: number };
  roundTripMs: number;
}): Promise<LatencyProxy> {
  const oneWayMs = options.roundTripMs / 2;
  const sockets = new Set<Socket>();

  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = createConnection({
      host: options.target.host,
      port: options.target.port,
      allowHalfOpen: true
    });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const toUpstream = relay(client, upstream, oneWayMs);
    const toClient = relay(upstream, client, oneWayMs);
    const pairs = [
      { socket: client, peer: upstream, inbound: toClient },
      { socket: upstream, peer: client, inbound: toUpstream }
    ];
    for (const { socket, peer, inbound } of pairs) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", (hadError) => {
        sockets.delete(socket);
        // Nothing more can reach this socket. A clean close has already
        // queued its end for the peer, which then closes in turn; an error
        // takes the peer down with it.
        inbound.clear();
        if (hadError) peer.destroy();
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("latency_proxy_address_unavailable");
  }

  return {
    host: address.address,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}

/** `databaseUrl` with its host and port pointed at the proxy. */
export function throughProxy(databaseUrl: string, proxy: LatencyProxy): string {
  const url = new URL(databaseUrl);
  url.hostname = proxy.host;
  url.port = String(proxy.port);
  return url.toString();
}
