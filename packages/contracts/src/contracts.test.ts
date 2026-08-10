import { expect, it } from "vitest";
import {
  characterResourceSchema,
  characterSchema,
  createSearchResponseSchema,
  historyPageSchema,
  historicalSnapshotSchema,
  jobStatusResponseSchema,
  publicErrorCodeSchema,
  publicErrorHttpStatus,
  publicErrorMessages,
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

it("rejects fingerprint sweep internals in a public character response", () => {
  // Break caught: adding a worker-only field to a public API response would
  // disclose the source or confidence of a fingerprint-derived link.
  const value = {
    ...currentCharacter,
    discoverySource: "fingerprint",
    snapshot: {
      ...currentCharacter.snapshot,
      reservationId: "private-reservation-id",
      characters: [
        {
          ...character,
          source: "fingerprint",
          fingerprintScore: 100
        }
      ]
    }
  };

  expect(characterResourceSchema.safeParse(value).success).toBe(false);
});

it("accepts every character value the upstream normalizer accepts", () => {
  // Break caught: a level the Raider.IO normalizer commits to an immutable snapshot
  // could be rejected by the public schema, breaking that character page forever.
  expect(characterSchema.parse({ ...character, level: 0 }).level).toBe(0);
  expect(characterSchema.safeParse({ ...character, level: -1 }).success).toBe(
    false
  );
  expect(characterSchema.safeParse({ ...character, level: 1.5 }).success).toBe(
    false
  );
});

it("publishes one public message per error code", () => {
  // Break caught: duplicated message tables could drift so one code yields two
  // different public messages depending on which adapter produced it.
  for (const code of publicErrorCodeSchema.options) {
    expect(
      safeApiErrorSchema.parse({
        error: { code, message: publicErrorMessages[code] }
      }).error.message
    ).toBe(publicErrorMessages[code]);
  }
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

it("defines contract-safe authentication and trusted-boundary errors", () => {
  // Break caught: HTTP adapters could emit auth errors outside the strict v1 schema.
  expect(
    safeApiErrorSchema.parse({
      error: { code: "unauthorized", message: "Authentication failed." }
    }).error.code
  ).toBe("unauthorized");
  expect(
    safeApiErrorSchema.parse({
      error: {
        code: "trusted_client_ip_unavailable",
        message: "The trusted client boundary is unavailable."
      }
    }).error.code
  ).toBe("trusted_client_ip_unavailable");
  expect(publicErrorHttpStatus.unauthorized).toBe(401);
  expect(publicErrorHttpStatus.trusted_client_ip_unavailable).toBe(503);
});
