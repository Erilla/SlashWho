import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import { applicationConfigSchema } from "./config";
import { createBotDossierService } from "./bot-dossier-service";
import type { StoredDossierStatus } from "./applicant-dossier-service";
import type {
  CreateSearchResult,
  PublicReadAuthorizationResult
} from "./search-service";

const root: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const alt: CharacterKey = { region: "eu", realm: "silvermoon", name: "alt" };
const third: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "third"
};
const config = applicationConfigSchema.parse({
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
});

function keyOf(url: string): CharacterKey {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return {
    region: parts[1] as CharacterKey["region"],
    realm: parts[2]!,
    name: parts[3]!
  };
}

function job(key: CharacterKey, joined = false): CreateSearchResult {
  return {
    kind: "job",
    jobId: "00000000-0000-4000-8000-000000000010",
    status: "queued",
    statusUrl: "/api/v1/searches/00000000-0000-4000-8000-000000000010",
    characterUrl: `/characters/${key.region}/${key.realm}/${key.name}`,
    staleCharacter: null,
    joinedExistingRun: joined,
    profile: {
      key,
      displayName: key.name,
      className: "Mage",
      level: 80,
      guild: null,
      ownerId: null,
      profileGuess: null,
      declaredMain: null
    }
  };
}

const collecting: StoredDossierStatus = {
  kind: "ok",
  snapshotId: null,
  snapshotState: null,
  lastCollectedAt: null,
  evidence: [],
  evidenceRunIds: [],
  activeDiscovery: true
};

function fixture(
  options: {
    results?: (key: CharacterKey) => CreateSearchResult;
    links?: { key: CharacterKey; origin: string }[];
    completed?: CharacterKey[];
  } = {}
) {
  const links = options.links?.map((entry) => ({ ...entry })) ?? [];
  const ensure = vi.fn(async () => "id");
  const charge = vi.fn<() => Promise<PublicReadAuthorizationResult>>(
    async () => ({ allowed: true })
  );
  const create = vi.fn(async (input: { characterUrl: string }) =>
    (options.results ?? (() => job(root)))(keyOf(input.characterUrl))
  );
  const add = vi.fn(
    async (
      _root: CharacterKey,
      target: CharacterKey,
      addOptions: { origin: "bot" }
    ) => {
      if (links.some((link) => link.key.name === target.name)) {
        return "duplicate" as const;
      }
      links.push({ key: target, origin: addOptions.origin });
      return "added" as const;
    }
  );
  const service = createBotDossierService({
    repositories: {
      characters: { ensure, find: vi.fn(async () => true) },
      manualConnections: {
        list: vi.fn(async () =>
          links.map((link) => ({
            key: link.key,
            displayName: link.key.name,
            className: "Mage",
            level: 80,
            raiderIoUrl: `https://raider.io/characters/${link.key.region}/${link.key.realm}/${link.key.name}`,
            pending: false,
            origin: link.origin as "bot",
            excluded: false
          }))
        ),
        add
      },
      suppressions: { isActive: vi.fn(async () => false) },
      evidence: {
        getCompleted: vi.fn(async (key: CharacterKey) =>
          options.completed?.some((item) => item.name === key.name)
            ? ({} as never)
            : null
        )
      },
      snapshots: {} as never,
      runs: {} as never
    } as never,
    search: {
      create,
      authorizeSearchAllowance: charge
    },
    dossiers: {
      readStatus: vi.fn(async () => collecting),
      readStored: vi.fn(async () => ({ kind: "not_found" as const })),
      refreshCharacter: vi.fn(async () => ({
        mode: "full" as const,
        lastCollectedAt: null,
        clearedTiers: 0
      }))
    },
    config
  });
  return { service, create, add, ensure, links, charge };
}

const headers = new Headers();

describe("bot dossier create", () => {
  it("deduplicates URLs, charges once and never self-links", async () => {
    const { service, create, links } = fixture();
    const result = await service.create({
      characters: [
        "https://raider.io/characters/eu/silvermoon/ryii",
        "https://raider.io/characters/eu/silvermoon/alt",
        "https://raider.io/characters/eu/silvermoon/ryii"
      ],
      headers
    });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected created");
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.body.outcomes.map((outcome) => outcome.key.name)).toEqual([
      "ryii",
      "alt"
    ]);
    expect(links).toEqual([{ key: alt, origin: "bot" }]);
  });

  it("writes the link for an accepted character even when it joined an existing run", async () => {
    const { service, links } = fixture({
      results: (key) => job(key, true)
    });
    const result = await service.create({
      characters: [
        "https://raider.io/characters/eu/silvermoon/ryii",
        "https://raider.io/characters/eu/silvermoon/alt"
      ],
      headers
    });
    if (result.kind !== "created") throw new Error("expected created");
    expect(result.body.outcomes[1]).toMatchObject({
      outcome: "existing",
      key: alt
    });
    expect(links).toEqual([{ key: alt, origin: "bot" }]);
    expect(result.status).toBe(200);
  });

  it("links nothing for a suppressed or rate-limited character", async () => {
    const { service, links } = fixture({
      results: (key) => {
        if (key.name === alt.name)
          return { kind: "not_found", code: "suppressed_character" };
        if (key.name === third.name)
          return { kind: "rate_limited", retryAfterSeconds: 17 };
        return job(root);
      }
    });
    const result = await service.create({
      characters: [
        "https://raider.io/characters/eu/silvermoon/ryii",
        "https://raider.io/characters/eu/silvermoon/alt",
        "https://raider.io/characters/eu/silvermoon/third"
      ],
      headers
    });
    if (result.kind !== "created") throw new Error("expected created");
    expect(result.body.outcomes).toMatchObject([
      { outcome: "queued" },
      { outcome: "suppressed" },
      { outcome: "rate_limited" }
    ]);
    expect(result.body.retryAfterSeconds).toBe(17);
    expect(result.status).toBe(202);
    expect(links).toEqual([]);
  });

  it("refuses a suppressed root before writing anything", async () => {
    const { service, ensure, links } = fixture({
      results: () => ({ kind: "not_found", code: "suppressed_character" })
    });
    const result = await service.create({
      characters: ["https://raider.io/characters/eu/silvermoon/ryii"],
      headers
    });
    expect(result).toEqual({
      kind: "suppressed",
      code: "suppressed_character"
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(links).toEqual([]);
  });

  it("queues no second discovery run on replay and repairs a missing link", async () => {
    const { service, create, links } = fixture({
      results: (key) => job(key, true)
    });
    const result = await service.create({
      characters: [
        "https://raider.io/characters/eu/silvermoon/ryii",
        "https://raider.io/characters/eu/silvermoon/alt"
      ],
      headers
    });
    if (result.kind !== "created") throw new Error("expected created");
    expect(
      result.body.outcomes.every((outcome) => outcome.outcome === "existing")
    ).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(links).toEqual([{ key: alt, origin: "bot" }]);
  });

  it("rejects an invalid URL before any search or charge", async () => {
    const { service, create, charge } = fixture();
    const result = await service.create({
      characters: ["not a character"],
      headers
    });
    expect(result).toEqual({
      kind: "invalid",
      code: "invalid_character_url"
    });
    expect(create).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
  });
});

describe("bot dossier refresh", () => {
  it("refuses a refresh when the search bucket is empty", async () => {
    const { service, charge } = fixture();
    charge.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 5
    });
    await expect(service.refresh(root, { headers })).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 5
    });
  });
});

describe("bot dossier add-character", () => {
  it("resumes a link with no completed evidence", async () => {
    const { service, create, add, links } = fixture({
      links: [{ key: alt, origin: "bot" }]
    });
    const result = await service.addCharacter(root, {
      characterUrl: "https://raider.io/characters/eu/silvermoon/alt",
      headers
    });
    expect(result).toMatchObject({ kind: "linked" });
    expect(create).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledOnce();
    expect(links).toEqual([{ key: alt, origin: "bot" }]);
  });

  it("does not search a link that already has completed evidence", async () => {
    const { service, create } = fixture({
      links: [{ key: alt, origin: "applicant_sheet" }],
      completed: [alt]
    });
    const result = await service.addCharacter(root, {
      characterUrl: "https://raider.io/characters/eu/silvermoon/alt",
      headers
    });
    expect(result).toEqual({ kind: "linked" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a self-link", async () => {
    const { service, create } = fixture();
    const result = await service.addCharacter(root, {
      characterUrl: "https://raider.io/characters/eu/silvermoon/ryii",
      headers
    });
    expect(result).toEqual({
      kind: "invalid",
      code: "invalid_character_url"
    });
    expect(create).not.toHaveBeenCalled();
  });
});
