import { Worker } from "node:worker_threads";

import { finiteNumber, record as valueRecord } from "@slashwho/upstream-http";

import type { AchievementFingerprint } from "./types";

export function fingerprintFromResponse(
  value: unknown
): AchievementFingerprint | null {
  const response = valueRecord(value);
  if (!response || !Array.isArray(response.achievements)) return null;

  const fingerprint = new Map<number, number>();
  for (const achievement of response.achievements) {
    const entry = valueRecord(achievement);
    const id = entry && finiteNumber(entry.id);
    const timestamp = entry && finiteNumber(entry.completed_timestamp);
    if (id !== null && timestamp !== null) fingerprint.set(id, timestamp);
  }
  return fingerprint;
}

/**
 * Parses an achievements body on the calling thread. `null` means the body was
 * not JSON or not the expected shape, exactly as `fingerprintFromResponse`
 * reports it.
 */
export function fingerprintFromBytes(
  body: ArrayBuffer
): AchievementFingerprint | null {
  try {
    return fingerprintFromResponse(
      JSON.parse(new TextDecoder().decode(body)) as unknown
    );
  } catch {
    return null;
  }
}

/** Parses an achievements body, wherever the work runs. */
export interface FingerprintParser {
  parse(body: ArrayBuffer): Promise<AchievementFingerprint | null>;
}

export interface FingerprintParserPool extends FingerprintParser {
  /** Ends the pool's threads. Parsing after this runs on the calling thread. */
  close(): Promise<void>;
}

/**
 * The thread's whole program, as source rather than a file. A file would have
 * to survive the web bundler, the worker's `tsx` runtime and the test runner
 * alike; a string is loaded the same way by all of them. It must match
 * `fingerprintFromResponse` and is tested against it. The reply is a flat
 * `[id, timestamp, id, timestamp, ...]` array handed back without a copy, so
 * the 1.9 MB object graph never crosses the thread boundary. `null` is a body
 * that is not the expected shape.
 */
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const decoder = new TextDecoder();
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
parentPort.on("message", ({ id, body }) => {
  try {
    const response = JSON.parse(decoder.decode(body));
    if (!isRecord(response) || !Array.isArray(response.achievements)) {
      parentPort.postMessage({ id, pairs: null });
      return;
    }
    const source = response.achievements;
    const pairs = new Float64Array(source.length * 2);
    let length = 0;
    for (const entry of source) {
      if (!isRecord(entry)) continue;
      const { id: achievementId, completed_timestamp: timestamp } = entry;
      if (
        typeof achievementId !== "number" || !Number.isFinite(achievementId) ||
        typeof timestamp !== "number" || !Number.isFinite(timestamp)
      ) continue;
      pairs[length++] = achievementId;
      pairs[length++] = timestamp;
    }
    parentPort.postMessage({ id, pairs: pairs.subarray(0, length) }, [pairs.buffer]);
  } catch {
    parentPort.postMessage({ id, pairs: null });
  }
});
`;

const defaultWorker = (source: string): Worker =>
  new Worker(source, { eval: true });

type Pending = {
  body: ArrayBuffer;
  resolve: (value: AchievementFingerprint | null) => void;
};

type PoolThread = {
  worker: Worker;
  pending: Map<number, Pending>;
  dead: boolean;
};

/**
 * Parses achievements bodies on `size` worker threads. The main thread only
 * hands a body over and builds the small map from what comes back.
 *
 * A thread that dies leaves its parses to be redone on the calling thread, so
 * a broken pool costs speed and never a verdict. The threads are `unref`ed, and the
 * owner should still `close()` the pool at shutdown rather than rely on that.
 */
export function createFingerprintParserPool(
  size: number,
  options: {
    /**
     * Called when a thread dies while the pool is open, with how many parses
     * it was holding. Those parses are redone on the calling thread, so
     * without this a pool that cannot run would look like a working one.
     */
    onThreadDeath?: (death: { pendingParses: number }) => void;
    /** Starts a thread; replaced only by tests that need to kill one. */
    createWorker?: (source: string) => Worker;
  } = {}
): FingerprintParserPool {
  const threads: PoolThread[] = [];
  let nextId = 0;
  let closed = false;

  function spawn(): PoolThread {
    const worker = (options.createWorker ?? defaultWorker)(WORKER_SOURCE);
    const thread: PoolThread = { worker, pending: new Map(), dead: false };
    worker.on(
      "message",
      (message: { id: number; pairs: Float64Array | null }) => {
        const pending = thread.pending.get(message.id);
        if (!pending) return;
        thread.pending.delete(message.id);
        if (thread.pending.size === 0) worker.unref();
        const { pairs } = message;
        if (pairs === null) {
          pending.resolve(null);
          return;
        }
        const fingerprint = new Map<number, number>();
        for (let index = 0; index < pairs.length; index += 2) {
          fingerprint.set(pairs[index]!, pairs[index + 1]!);
        }
        pending.resolve(fingerprint);
      }
    );
    const fail = () => {
      if (thread.dead) return;
      thread.dead = true;
      if (!closed)
        options.onThreadDeath?.({ pendingParses: thread.pending.size });
      for (const pending of thread.pending.values()) {
        pending.resolve(fingerprintFromBytes(pending.body));
      }
      thread.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", fail);
    // Last, on purpose: on Node 22 adding a "message" listener refs the thread
    // again, so an earlier unref would be silently undone. `parse` refs it
    // for as long as it has a parse pending.
    worker.unref();
    return thread;
  }

  function pick(): PoolThread | undefined {
    for (let index = threads.length - 1; index >= 0; index -= 1) {
      if (threads[index]!.dead) threads.splice(index, 1);
    }
    if (threads.length < size) {
      const thread = spawn();
      threads.push(thread);
      return thread;
    }
    return threads.reduce((least, thread) =>
      thread.pending.size < least.pending.size ? thread : least
    );
  }

  return {
    parse(body) {
      if (closed) return Promise.resolve(fingerprintFromBytes(body));
      let thread: PoolThread | undefined;
      try {
        thread = pick();
      } catch {
        return Promise.resolve(fingerprintFromBytes(body));
      }
      if (!thread) return Promise.resolve(fingerprintFromBytes(body));

      const id = nextId++;
      return new Promise((resolve) => {
        // Transferring detaches `body`, so the thread that dies mid-parse
        // needs its own copy to redo the work; the copy is only kept until
        // the reply arrives. A 1.9 MB copy is a memcpy, not a parse.
        const retained = body.slice(0);
        // Held open only while it owes a reply: a thread nobody is waiting on
        // must not keep the process alive, and one somebody is waiting on must.
        if (thread.pending.size === 0) thread.worker.ref();
        thread.pending.set(id, { body: retained, resolve });
        try {
          thread.worker.postMessage({ id, body }, [body]);
        } catch {
          thread.pending.delete(id);
          // Ref'd above for this parse; nothing else owes a reply.
          if (thread.pending.size === 0) thread.worker.unref();
          resolve(fingerprintFromBytes(retained));
        }
      });
    },
    async close() {
      closed = true;
      await Promise.all(threads.map((thread) => thread.worker.terminate()));
    }
  };
}
