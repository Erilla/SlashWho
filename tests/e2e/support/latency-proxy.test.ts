import {
  createConnection,
  createServer,
  type Server,
  type Socket
} from "node:net";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseRoundTripMs,
  startLatencyProxy,
  throughProxy,
  type LatencyProxy
} from "./latency-proxy";

type Echo = Readonly<{ port: number; server: Server }>;

/** Echoes every chunk at once, or, with `onEnd`, answers only after the end. */
async function startEcho(
  handle: (socket: Socket) => void = (socket) => socket.pipe(socket)
): Promise<Echo> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setNoDelay(true);
    handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("echo");
  return { port: address.port, server };
}

async function connect(proxy: LatencyProxy): Promise<Socket> {
  const socket = createConnection({ host: proxy.host, port: proxy.port });
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

/** Sends one byte and waits for it to come back, `count` times; the median. */
async function medianRoundTripMs(socket: Socket, count: number) {
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      socket.once("data", () => resolve());
      socket.write("x");
    });
    times.push(performance.now() - startedAt);
  }
  times.sort((left, right) => left - right);
  return times[Math.floor(times.length / 2)]!;
}

describe("startLatencyProxy", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setUp(roundTripMs: number, echo?: Echo) {
    const target = echo ?? (await startEcho());
    cleanups.push(
      () => new Promise<void>((resolve) => target.server.close(() => resolve()))
    );
    const proxy = await startLatencyProxy({
      target: { host: "127.0.0.1", port: target.port },
      roundTripMs
    });
    cleanups.push(proxy.close);
    const socket = await connect(proxy);
    cleanups.push(() => void socket.destroy());
    return socket;
  }

  it("holds each round trip for the configured time", async () => {
    // Break caught: a proxy that passes chunks straight through measures
    // nothing, and one that delays each direction by the full round trip
    // doubles it.
    const socket = await setUp(20);
    const median = await medianRoundTripMs(socket, 11);
    expect(median).toBeGreaterThanOrEqual(19);
    expect(median).toBeLessThan(38);
  });

  it("resolves a round trip finer than the Windows system timer", async () => {
    // Break caught: releasing chunks with setTimeout rounds each direction up
    // to the ~15.6 ms Windows timer, so a 2 ms setting measured ~31 ms (#666),
    // and without noDelay Nagle's algorithm holds the byte back.
    const socket = await setUp(2);
    const median = await medianRoundTripMs(socket, 21);
    expect(median).toBeGreaterThanOrEqual(1.9);
    expect(median).toBeLessThan(15);
  });

  it("delivers chunks in the order they were sent", async () => {
    const socket = await setUp(4);
    const expected = Array.from({ length: 200 }, (_, index) => `${index};`);
    let received = "";
    const done = new Promise<void>((resolve) => {
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.length >= expected.join("").length) resolve();
      });
    });
    for (const message of expected) {
      socket.write(message);
      // Spread the writes out so they cross the proxy as separate chunks.
      if (Number(message.slice(0, -1)) % 20 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    await done;
    expect(received).toBe(expected.join(""));
  });

  it("stops reading while the destination is full", async () => {
    // Break caught: ignoring write()'s return value makes the proxy read
    // everything the sender offers and hold it in memory for a slow reader.
    let target: Socket | undefined;
    const echo = await startEcho((socket) => {
      target = socket;
      socket.pause();
    });
    const socket = await setUp(0, echo);
    // The sender writes only while its own socket accepts more, so it can get
    // no further than the proxy lets it.
    const total = 256 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let accepted = 0;
    const offer = () => {
      while (accepted < total) {
        accepted += chunk.length;
        if (!socket.write(chunk)) return;
      }
    };
    socket.on("drain", offer);
    offer();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The proxy stopped reading, so the sender is still waiting to drain.
    expect(accepted).toBeLessThan(total);

    let received = 0;
    const all = new Promise<void>((resolve) => {
      target!.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received >= total) resolve();
      });
    });
    target!.resume();
    await all;
    expect(received).toBe(total);
    target!.destroy();
  });

  it("never lets the end overtake the data sent before it", async () => {
    // Break caught: relaying `end` directly, rather than through the delay
    // queue, closes the upstream before the last chunks reach it.
    const echo = await startEcho((socket) => {
      let body = "";
      socket.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      socket.on("end", () => socket.end(`got:${body}`));
    });
    const socket = await setUp(10, echo);
    let reply = "";
    socket.on("data", (chunk: Buffer) => (reply += chunk.toString("utf8")));
    const ended = new Promise<void>((resolve) => socket.once("end", resolve));
    socket.write("first,");
    socket.end("last");
    await ended;
    expect(reply).toBe("got:first,last");
  });
});

describe("parseRoundTripMs", () => {
  it("means no proxy when the variable is unset or empty", () => {
    expect(parseRoundTripMs(undefined)).toBeUndefined();
    expect(parseRoundTripMs("")).toBeUndefined();
  });

  it("accepts zero and fractional milliseconds", () => {
    expect(parseRoundTripMs("0")).toBe(0);
    expect(parseRoundTripMs("0.5")).toBe(0.5);
    expect(parseRoundTripMs("5")).toBe(5);
  });

  it("fails rather than quietly profiling without latency", () => {
    for (const value of ["-1", "5ms", "NaN", "Infinity"]) {
      expect(() => parseRoundTripMs(value)).toThrow(
        "profile_db_rtt_ms_invalid"
      );
    }
  });
});

describe("throughProxy", () => {
  it("points the database URL at the proxy and keeps everything else", () => {
    const proxy = { host: "127.0.0.1", port: 6543, close: async () => {} };
    expect(
      throughProxy(
        "postgres://slashwho:secret@localhost:55432/slashwho_e2e",
        proxy
      )
    ).toBe("postgres://slashwho:secret@127.0.0.1:6543/slashwho_e2e");
  });
});
