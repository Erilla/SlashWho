import { expect, it } from "vitest";
import {
  characterResourceSchema,
  createSearchResponseSchema,
  historyPageSchema,
  historicalSnapshotSchema,
  jobStatusResponseSchema,
  safeApiErrorSchema
} from "./index";

const character = {
  region: "eu",
  realm: "silvermoon",
  name: "Ryii",
  className: "Mage",
  level: 80,
  raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii"
};

const currentCharacter = {
  character,
  snapshot: {
    id: "13af3173-e97c-4c78-a6cb-a54b647b209f",
    state: "complete",
    refreshedAt: "2026-08-04T12:30:00.000Z",
    characterCount: 1,
    characters: [character]
  },
  activeJob: null
};

it("rejects internal provenance in a public character response", () => {
  const value = {
    ...currentCharacter,
    snapshot: {
      ...currentCharacter.snapshot,
      characters: [{ ...character, source: "profile_guess" }]
    }
  };

  expect(characterResourceSchema.safeParse(value).success).toBe(false);
});

it("accepts queued and cached search outcomes", () => {
  const queued = {
    kind: "job",
    jobId: "54f14e37-7df7-43db-91d5-21e797d1d145",
    status: "queued",
    statusUrl: "/api/v1/searches/54f14e37-7df7-43db-91d5-21e797d1d145",
    characterUrl: "/characters/eu/silvermoon/ryii"
  };
  const cached = { kind: "character", character: currentCharacter };

  expect(createSearchResponseSchema.parse(queued).kind).toBe("job");
  expect(createSearchResponseSchema.parse(cached).kind).toBe("character");
});

it("validates every other public API response shape", () => {
  expect(
    jobStatusResponseSchema.parse({
      jobId: "54f14e37-7df7-43db-91d5-21e797d1d145",
      status: "retrying",
      characterUrl: "/characters/eu/silvermoon/ryii",
      createdAt: "2026-08-04T12:00:00.000Z",
      startedAt: "2026-08-04T12:01:00.000Z",
      completedAt: null,
      retryAt: "2026-08-04T12:02:00.000Z",
      error: null
    }).status
  ).toBe("retrying");

  expect(
    historyPageSchema.parse({
      items: [
        {
          id: "13af3173-e97c-4c78-a6cb-a54b647b209f",
          refreshedAt: "2026-08-04T12:30:00.000Z",
          state: "partial",
          characterCount: 4,
          url: "/api/v1/characters/eu/silvermoon/ryii/history/13af3173-e97c-4c78-a6cb-a54b647b209f",
          characterUrl:
            "/characters/eu/silvermoon/ryii/history/13af3173-e97c-4c78-a6cb-a54b647b209f"
        }
      ],
      nextCursor: null
    }).items[0]?.state
  ).toBe("partial");

  expect(
    historicalSnapshotSchema.parse({
      id: "13af3173-e97c-4c78-a6cb-a54b647b209f",
      root: character,
      refreshedAt: "2026-08-04T12:30:00.000Z",
      state: "complete",
      characters: [character]
    }).characters[0]?.name
  ).toBe("Ryii");

  expect(
    safeApiErrorSchema.parse({
      error: { code: "rate_limited", message: "Too many searches." }
    }).error.code
  ).toBe("rate_limited");
});
