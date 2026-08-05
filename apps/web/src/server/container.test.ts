import type { DiscoveryQueue, Repositories } from "@slashwho/database";
import { expect, it } from "vitest";

import { createWebContainer } from "./container";

it("migrates and initializes the durable queue before serving searches", async () => {
  // Break caught: a route could run against an old schema or an uninitialized queue.
  const events: string[] = [];
  const pool = {
    async query() {
      events.push("query");
      return {};
    },
    async end() {}
  };
  const queue = {
    async start() {
      events.push("queue");
    },
    async enqueue() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async work() {},
    async scheduleMaintenanceCleanup() {},
    async stop() {},
    isReady() {
      return true;
    }
  } satisfies DiscoveryQueue;
  const repositories = {} as Repositories;

  const container = await createWebContainer(
    {
      databaseUrl: "postgresql://db/slashwho",
      application: {
        BOT_API_KEY: "b".repeat(32),
        RATE_LIMIT_HASH_SECRET: "r".repeat(32),
        ANONYMOUS_SEARCHES_PER_HOUR: 10,
        BOT_SEARCHES_PER_HOUR: 60,
        PUBLIC_READS_PER_MINUTE: 300,
        FRESHNESS_HOURS: 24,
        NEGATIVE_CACHE_MINUTES: 15,
        DISCOVERY_REQUEST_CAP: 12
      }
    },
    {
      createPool() {
        return pool;
      },
      async runMigrations() {
        events.push("migrate");
      },
      createRepositories() {
        events.push("repositories");
        return repositories;
      },
      createQueue() {
        return queue;
      },
      createSearchService() {
        events.push("service");
        return {} as never;
      }
    }
  );

  expect(events).toEqual(["migrate", "repositories", "queue", "service"]);
  await expect(container.ready()).resolves.toBe(true);
  expect(events.at(-1)).toBe("query");
});
