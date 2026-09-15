import type { DiscoveryQueue, Repositories } from "@slashwho/database";
import { expect, it, vi } from "vitest";

import { createWebContainer } from "./container";
import { createContainerProvider } from "./container";

// Mocked so the upstream_throttle test below can assert against a plain
// spy instead of parsing pino's serialized output; production code is
// untouched since this only replaces the module inside this test file.
vi.mock("./logger", () => ({ webLogger: { info: vi.fn() } }));
const { webLogger } = await import("./logger");

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
    async enqueueFingerprintAdmission() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async enqueueCharacterEvidence() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async work() {},
    async workFingerprintAdmissions() {},
    async workCharacterEvidence() {},
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
        DOSSIER_CHARACTER_CAP: 12,
        DOSSIER_PROVIDER_CONCURRENCY: 4
      },
      dossier: {
        raiderIoBaseUrl: "https://raider.io",
        raiderIoTimeoutMs: 10_000,
        blizzardClientId: "blizzard-client-id",
        blizzardClientSecret: "blizzard-client-secret",
        evidenceJobCredentialEncryptionKey: Buffer.alloc(32, "a")
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
      },
      createRaiderIoGateway() {
        return {} as never;
      },
      createBlizzardGateway() {
        return {} as never;
      },
      createApplicantDossierService() {
        return {} as never;
      }
    }
  );

  expect(events).toEqual(["migrate", "repositories", "queue", "service"]);
  await expect(container.ready()).resolves.toBe(true);
  expect(events.at(-1)).toBe("query");
});

it("exposes a dossier service built from server-only gateway dependencies", async () => {
  // Break caught: dossier routes could construct their own clients or lose the
  // shared repository/search dependencies needed to reuse discovery work.
  const pool = { async query() {}, async end() {} };
  const queue = {
    async start() {},
    async enqueue() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async enqueueFingerprintAdmission() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async enqueueCharacterEvidence() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async work() {},
    async workFingerprintAdmissions() {},
    async workCharacterEvidence() {},
    async scheduleMaintenanceCleanup() {},
    async stop() {},
    isReady() {
      return true;
    }
  } satisfies DiscoveryQueue;
  const dossiers = {
    async start() {
      return {
        kind: "invalid" as const,
        code: "invalid_character_url" as const
      };
    },
    async addConnectedCharacter() {
      return {
        kind: "invalid" as const,
        code: "invalid_character_url" as const
      };
    },
    async read() {
      return { kind: "not_ready" as const };
    },
    async readInitial() {
      return { kind: "not_ready" as const };
    },
    async setConnectedCharacterExclusion() {
      return { kind: "updated" as const };
    },
    async removeConnectedCharacter() {
      return { kind: "removed" as const };
    }
  };

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
        DOSSIER_CHARACTER_CAP: 12,
        DOSSIER_PROVIDER_CONCURRENCY: 4
      },
      dossier: {
        raiderIoBaseUrl: "https://raider.io",
        raiderIoTimeoutMs: 10_000,
        blizzardClientId: "blizzard-client-id",
        blizzardClientSecret: "blizzard-client-secret",
        evidenceJobCredentialEncryptionKey: Buffer.alloc(32, "a")
      }
    },
    {
      createPool() {
        return pool;
      },
      async runMigrations() {},
      createRepositories() {
        return {} as Repositories;
      },
      createQueue() {
        return queue;
      },
      createSearchService() {
        return {} as never;
      },
      createRaiderIoGateway() {
        return {} as never;
      },
      createBlizzardGateway() {
        return {} as never;
      },
      createApplicantDossierService() {
        return dossiers;
      }
    }
  );

  expect(container.dossiers).toBe(dossiers);
});

it("clears a rejected startup promise so the next request can recover", async () => {
  // Break caught: one transient migration/queue outage could poison every later request.
  let attempts = 0;
  const provider = createContainerProvider(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary_database_outage");
    return {
      searches: {} as never,
      dossiers: {} as never,
      async ready() {
        return true;
      },
      async close() {}
    };
  });

  await expect(provider()).rejects.toThrow("temporary_database_outage");
  await expect(provider()).resolves.toMatchObject({ searches: {} });
  expect(attempts).toBe(2);
});

it("wires a working onThrottle from both provider gateways to the web logger", async () => {
  // Break caught: the composition root could stop passing onThrottle to the
  // clients it constructs (or never wire it in the first place) with nothing
  // here to notice -- upstream throttling would then vanish from the logs.
  const pool = { async query() {}, async end() {} };
  const queue = {
    async start() {},
    async enqueue() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async enqueueFingerprintAdmission() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async enqueueCharacterEvidence() {
      return "54f14e37-7df7-43db-91d5-21e797d1d145";
    },
    async work() {},
    async workFingerprintAdmissions() {},
    async workCharacterEvidence() {},
    async scheduleMaintenanceCleanup() {},
    async stop() {},
    isReady() {
      return true;
    }
  } satisfies DiscoveryQueue;
  let raiderIoOnThrottle:
    ((event: { retryAfterMs: number | undefined }) => void) | undefined;
  let blizzardOnThrottle:
    ((event: { retryAfterMs: number | undefined }) => void) | undefined;

  await createWebContainer(
    {
      databaseUrl: "postgresql://db/slashwho",
      application: {
        BOT_API_KEY: "b".repeat(32),
        RATE_LIMIT_HASH_SECRET: "r".repeat(32),
        ANONYMOUS_SEARCHES_PER_HOUR: 10,
        BOT_SEARCHES_PER_HOUR: 60,
        PUBLIC_READS_PER_MINUTE: 300,
        FRESHNESS_HOURS: 24,
        DOSSIER_CHARACTER_CAP: 12,
        DOSSIER_PROVIDER_CONCURRENCY: 4
      },
      dossier: {
        raiderIoBaseUrl: "https://raider.io",
        raiderIoTimeoutMs: 10_000,
        blizzardClientId: "blizzard-client-id",
        blizzardClientSecret: "blizzard-client-secret",
        evidenceJobCredentialEncryptionKey: Buffer.alloc(32, "k")
      }
    },
    {
      createPool() {
        return pool;
      },
      async runMigrations() {},
      createRepositories() {
        return {} as Repositories;
      },
      createQueue() {
        return queue;
      },
      createSearchService() {
        return {} as never;
      },
      createRaiderIoGateway(options) {
        raiderIoOnThrottle = options.onThrottle;
        return {} as never;
      },
      createBlizzardGateway(options) {
        blizzardOnThrottle = options.onThrottle;
        return {} as never;
      },
      createApplicantDossierService() {
        return {} as never;
      }
    }
  );

  raiderIoOnThrottle?.({ retryAfterMs: 5_000 });
  blizzardOnThrottle?.({ retryAfterMs: undefined });

  expect(webLogger.info).toHaveBeenCalledWith({
    event: "upstream_throttle",
    provider: "raiderio",
    retryAfterMs: 5_000
  });
  expect(webLogger.info).toHaveBeenCalledWith({
    event: "upstream_throttle",
    provider: "blizzard",
    retryAfterMs: null
  });
});
