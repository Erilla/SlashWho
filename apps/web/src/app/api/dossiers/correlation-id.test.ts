import {
  applicationConfigSchema,
  createApplicantDossierService,
  createSearchService
} from "@slashwho/application";
import type { DiscoveryQueue, Repositories } from "@slashwho/database";
import { describe, expect, it, vi } from "vitest";

const root = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
const characterUrl = "https://raider.io/characters/eu/silvermoon/ryii";

const enqueued: Array<{ correlationId?: string }> = [];
const queue: Pick<DiscoveryQueue, "enqueue"> = {
  async enqueue(payload) {
    enqueued.push(payload);
    return payload.runId;
  }
};

const repositories = {
  searchReservations: {
    async reserve() {
      return {
        kind: "reserved" as const,
        run: {
          id: "00000000-0000-4000-8000-000000000060",
          rootKey: root,
          rootCharacterId: null,
          queueJobId: null,
          status: "queued" as const,
          callerClass: "public" as const,
          attempt: 0,
          nextRetryAt: null,
          errorCode: null,
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
          snapshotId: null
        }
      };
    },
    async cancel() {},
    async listPending() {
      return [];
    },
    async markEnqueued() {}
  },
  snapshots: {
    async getCurrent() {
      return null;
    },
    async find() {
      return null;
    },
    async listHistory() {
      return { items: [], nextCursor: null };
    },
    async create() {
      throw new Error("not used");
    },
    async createAndFinishFingerprintSweep() {
      throw new Error("not used");
    }
  },
  manualConnections: {
    async add() {
      return "added" as const;
    },
    async list() {
      return [];
    }
  },
  runs: {
    async createOrReuse() {
      throw new Error("not used");
    },
    async claim() {
      return null;
    },
    async markRunning() {},
    async markRetrying() {},
    async complete() {},
    async fail() {},
    async find() {
      return null;
    },
    async findActive() {
      return null;
    }
  },
  suppressions: {
    async suppress() {},
    async isActive() {
      return false;
    },
    async cleanupExpired() {
      return 0;
    }
  },
  rateLimits: {
    async reserve() {
      return { allowed: true, retryAt: null };
    },
    async record() {},
    async countActive() {
      return 0;
    },
    async cleanupExpired() {
      return 0;
    }
  },
  negativeCache: {
    async put() {},
    async putAndFailRun() {},
    async find() {
      return null;
    },
    async cleanupExpired() {
      return 0;
    }
  },
  evidence: {
    async reserve() {
      throw new Error("not used");
    },
    async find() {
      return null;
    },
    async claim() {
      return null;
    },
    async markEnqueued() {
      throw new Error("not used");
    },
    async publish() {
      throw new Error("not used");
    },
    async fail() {
      throw new Error("not used");
    },
    async getCompleted() {
      return null;
    },
    async listStatus() {
      return [];
    }
  },
  fingerprintSweeps: {
    async requestAdmission() {
      return { kind: "not_due" as const };
    },
    async recordRequest() {},
    async finish() {},
    async release() {},
    async listWaiting() {
      return [];
    },
    async listAdmittedUndispatched() {
      return [];
    },
    async markDispatched() {},
    async admitWaiting() {
      return { kind: "settled" as const };
    },
    async cleanupExpired() {
      return 0;
    }
  }
} as unknown as Repositories;

const config = applicationConfigSchema.parse({
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
});

const search = createSearchService({ repositories, queue, config });
const dossiers = createApplicantDossierService({
  repositories: {
    snapshots: {},
    evidence: {},
    manualConnections: {}
  } as unknown as Pick<
    Repositories,
    "snapshots" | "evidence" | "manualConnections"
  >,
  search,
  queue: { enqueueCharacterEvidence: vi.fn() },
  blizzard: { getCompletedAchievements: vi.fn() } as never,
  raiderio: { getMythicBossRankings: vi.fn(), getCharacter: vi.fn() } as never,
  config
});

vi.mock("../../../server/container", () => ({
  getContainer: async () => ({ dossiers, searches: {} })
}));

import { POST } from "./route";

describe("POST /api/dossiers correlation id plumbing", () => {
  it("carries the per-request correlation id all the way to queue.enqueue's payload", async () => {
    // Break caught: withHttpRequest mints a correlationId for logging and the
    // x-request-id header, but nothing wired it onto the command that reaches
    // search.create/queue.enqueue -- discovery_run rows would record a null
    // correlationId forever, and an operator reading that null would
    // reasonably conclude the request never reached the worker.
    enqueued.length = 0;

    const response = await POST(
      new Request("https://slashwho.example/api/dossiers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "203.0.113.8"
        },
        body: JSON.stringify({ characterUrl })
      })
    );

    expect(response.status).toBe(202);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.correlationId).toBe(requestId);
  });
});
