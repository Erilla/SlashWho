import { describe, expect, it } from "vitest";

import { startHealthServer } from "./health-server";

describe("worker health server", () => {
  it("exposes only readiness, successful-run age, and queue depth", async () => {
    // Break caught: the public operational probe could omit the worker signal
    // or leak character, run, credential, or fingerprint material.
    const server = await startHealthServer({
      port: 0,
      health: async () => ({ live: true, ready: true }),
      probe: async () => ({
        ready: true,
        lastSuccessfulRunAgeMs: 12_345,
        queueDepth: 2
      })
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/probe`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "ready",
        lastSuccessfulRunAgeMs: 12_345,
        queueDepth: 2
      });
    } finally {
      await server.stop();
    }
  });

  it("keeps liveness healthy while readiness follows initialization", async () => {
    // Break caught: an uninitialized worker could receive traffic as ready.
    let ready = false;
    const server = await startHealthServer({
      port: 0,
      health: async () => ({ live: true, ready }),
      probe: async () => ({
        ready,
        lastSuccessfulRunAgeMs: null,
        queueDepth: 0
      })
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const liveness = await fetch(`${baseUrl}/health`);
      const notReady = await fetch(`${baseUrl}/ready`);
      ready = true;
      const initialized = await fetch(`${baseUrl}/ready`);

      expect(liveness.status).toBe(200);
      await expect(liveness.json()).resolves.toEqual({ status: "ok" });
      expect(notReady.status).toBe(503);
      await expect(notReady.json()).resolves.toEqual({ status: "not_ready" });
      expect(initialized.status).toBe(200);
      await expect(initialized.json()).resolves.toEqual({ status: "ready" });
    } finally {
      await server.stop();
    }
  });

  it("does not expose application routes from the worker", async () => {
    // Break caught: the operational server could accidentally become a data surface.
    const server = await startHealthServer({
      port: 0,
      health: async () => ({ live: true, ready: true }),
      probe: async () => ({
        ready: true,
        lastSuccessfulRunAgeMs: null,
        queueDepth: 0
      })
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/characters/eu/silvermoon/private`
      );
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
