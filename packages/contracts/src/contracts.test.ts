import { expect, it } from "vitest";
import {
  applicantDossierSchema,
  characterResourceSchema,
  characterSchema,
  createDossierRequestSchema,
  createSearchResponseSchema,
  collectionMonitorResponseSchema,
  historyPageSchema,
  historicalSnapshotSchema,
  jobStatusResponseSchema,
  publicErrorCodeSchema,
  publicErrorHttpStatus,
  publicErrorMessages,
  safeApiErrorSchema
} from "./index";

const applicantCharacter = { region: "eu", realm: "silvermoon", name: "ryii" };
const validDossier = {
  root: applicantCharacter,
  research: {
    state: "initial",
    message: "Linked-character research is still running."
  },
  characters: [
    {
      key: applicantCharacter,
      displayName: "Ryii",
      className: "Mage",
      raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
      source: "raiderio_declared"
    }
  ],
  raids: [
    {
      raidId: "nerubar-palace",
      raidName: "Nerub-ar Palace",
      imageUrl: "https://render.example/raids/nerub-ar.jpg",
      cuttingEdge: true,
      bosses: [
        {
          bossId: "ansurek",
          bossName: "Queen Ansurek",
          bossOrder: 8,
          imageUrl: "https://render.example/bosses/ansurek.jpg",
          state: "kill",
          firstKill: {
            killedAt: "2024-10-01T20:00:00.000Z",
            guild: { name: "Guild", region: "eu", realm: "silvermoon" },
            historicWorldRank: null,
            reportUrl: "https://www.warcraftlogs.com/reports/example",
            characters: [applicantCharacter],
            parses: [
              {
                character: "Ryii",
                damage: {
                  state: "available",
                  percentile: 98.7,
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/example#fight=9"
                },
                healing: { state: "not_applicable" },
                bossDamage: { state: "unavailable" }
              }
            ]
          },
          bestParses: [
            {
              character: "Ryii",
              damage: {
                state: "available",
                percentile: 98.7,
                reportUrl:
                  "https://www.warcraftlogs.com/reports/example#fight=9"
              },
              healing: { state: "not_applicable" },
              bossDamage: { state: "unavailable" }
            }
          ]
        }
      ]
    }
  ],
  cuttingEdges: [],
  limitations: [
    {
      source: "warcraft_logs",
      character: null,
      code: "rate_limited",
      message: "Warcraft Logs is temporarily rate limited.",
      observedAt: "2026-09-15T12:00:00.000Z"
    }
  ]
};

it("accepts a provider reset timestamp on a rate-limited limitation", () => {
  const result = applicantDossierSchema.safeParse({
    ...validDossier,
    limitations: [
      {
        source: "raiderio",
        character: null,
        code: "rate_limited",
        message: "Raider.IO is temporarily rate limited.",
        observedAt: "2026-09-15T12:00:00.000Z",
        retryAt: "2026-09-15T12:05:00.000Z"
      }
    ]
  });

  expect(result.success).toBe(true);
});

it("publishes the unmatched-encounter limitation the dossier can emit", () => {
  // Break caught: the domain reports a kill it could not place in the
  // catalogue, and a code the contract rejects turns that into a failed
  // response rather than a visible gap.
  const result = applicantDossierSchema.safeParse({
    ...validDossier,
    limitations: [
      {
        source: "warcraft_logs",
        character: { region: "eu", realm: "silvermoon", name: "rinn" },
        code: "unmatched_encounter",
        message:
          "Some Mythic kills could not be matched to a known raid boss, so they are not shown.",
        observedAt: "2026-09-15T12:00:00.000Z"
      }
    ]
  });

  expect(result.success).toBe(true);
});

it("validates strict kill, wipe, no-log, and incomplete boss variants", () => {
  // Break caught: loose optional evidence fields could let a negative boss
  // carry stale kill data or a wipe omit its auditable report.
  const boss = validDossier.raids[0]!.bosses[0]!;
  const { firstKill, bestParses, ...metadata } = boss;
  void firstKill;
  void bestParses;
  const variants = [
    boss,
    {
      ...metadata,
      state: "wipe",
      wipe: {
        attemptedAt: "2024-09-01T20:00:00.000Z",
        reportUrl: "https://www.warcraftlogs.com/reports/wipe#fight=5",
        characters: [validDossier.root]
      }
    },
    { ...metadata, state: "no_logs" },
    { ...metadata, state: "incomplete" }
  ];
  for (const variant of variants) {
    expect(
      applicantDossierSchema.safeParse({
        ...validDossier,
        raids: [{ ...validDossier.raids[0], bosses: [variant] }]
      }).success
    ).toBe(true);
  }
  expect(
    applicantDossierSchema.safeParse({
      ...validDossier,
      raids: [
        {
          ...validDossier.raids[0],
          bosses: [{ ...boss, state: "no_logs" }]
        }
      ]
    }).success
  ).toBe(false);
});

function dossierWithParses(metric: unknown) {
  return {
    ...validDossier,
    raids: validDossier.raids.map((raid) => ({
      ...raid,
      bosses: raid.bosses.map((boss) => ({
        ...boss,
        firstKill: {
          ...boss.firstKill,
          parses: [
            {
              character: "Ryii",
              damage: metric,
              healing: { state: "not_applicable" },
              bossDamage: { state: "unavailable" }
            }
          ]
        },
        bestParses: [
          {
            character: "Ryii",
            damage: metric,
            healing: { state: "not_applicable" },
            bossDamage: { state: "unavailable" }
          }
        ]
      }))
    }))
  };
}

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

it("carries a character's current guild, which need not share its realm", () => {
  const withGuild = {
    ...validDossier,
    characters: [
      {
        ...validDossier.characters[0],
        guild: { name: "Rancour", region: "eu", realm: "draenor" }
      }
    ]
  };

  expect(applicantDossierSchema.parse(withGuild)).toEqual(withGuild);
});

it("still reads a snapshot written before characters carried a guild", () => {
  // The character schema is strict and parses immutable snapshots committed
  // before this field existed. Requiring a guild would make every one of them
  // permanently unreadable, so absent and null must both stay acceptable.
  expect(applicantDossierSchema.safeParse(validDossier).success).toBe(true);
  expect(
    applicantDossierSchema.safeParse({
      ...validDossier,
      characters: [{ ...validDossier.characters[0], guild: null }]
    }).success
  ).toBe(true);
});

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

it("defines a strict safe response while dossier discovery is pending", () => {
  // Break caught: the dossier route could hand-write a 409 response that its
  // advertised safe-error schema cannot validate.
  expect(
    safeApiErrorSchema.parse({
      error: {
        code: "discovery_not_ready",
        message: "Discovery is still in progress."
      }
    }).error.code
  ).toBe("discovery_not_ready");
  expect(publicErrorHttpStatus.discovery_not_ready).toBe(409);
  expect(publicErrorMessages.discovery_not_ready).toBe(
    "Discovery is still in progress."
  );
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

it("accepts a strict applicant dossier request and response", () => {
  // Break caught: browser input or a dossier response could add unvetted fields
  // to the reviewer surface, including raw upstream payloads.
  const characterUrl =
    "https://www.warcraftlogs.com/character/eu/silvermoon/ryii";

  expect(createDossierRequestSchema.parse({ characterUrl })).toEqual({
    characterUrl
  });
  expect(applicantDossierSchema.parse(validDossier)).toEqual(validDossier);
  const stringParticipants = {
    ...validDossier,
    raids: [
      {
        ...validDossier.raids[0]!,
        bosses: [
          {
            ...validDossier.raids[0]!.bosses[0]!,
            firstKill: {
              ...validDossier.raids[0]!.bosses[0]!.firstKill,
              characters: ["Ryii"]
            }
          }
        ]
      }
    ]
  };
  expect(applicantDossierSchema.safeParse(stringParticipants).success).toBe(
    false
  );
  expect(() =>
    applicantDossierSchema.parse({ ...validDossier, rawResponse: {} })
  ).toThrow();
});

it("requires a non-empty staged-research disclosure on applicant dossiers", () => {
  // Break caught: a dossier could be shown without making clear whether its
  // evidence is root-only, complete, or potentially incomplete.
  expect(applicantDossierSchema.parse(validDossier).research.state).toBe(
    "initial"
  );
  const dossierWithoutResearch = Object.fromEntries(
    Object.entries(validDossier).filter(([key]) => key !== "research")
  );
  expect(() => applicantDossierSchema.parse(dossierWithoutResearch)).toThrow();
});

it("requires a separate Cutting Edge achievement collection", () => {
  const dossierWithoutCuttingEdges = Object.fromEntries(
    Object.entries(validDossier).filter(([key]) => key !== "cuttingEdges")
  );
  expect(() =>
    applicantDossierSchema.parse(dossierWithoutCuttingEdges)
  ).toThrow();
});

it("rejects character attribution on account-wide Cutting Edge achievements", () => {
  // Break caught: a character list on this account-level record would make the
  // public contract imply a per-character achievement claim.
  expect(() =>
    applicantDossierSchema.parse({
      ...validDossier,
      cuttingEdges: [
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description:
            "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty.",
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: ["Ryii"]
        }
      ]
    })
  ).toThrow();
});

it("retains an unknown historic world rank as null", () => {
  // Break caught: an unavailable historic rank could be converted into a
  // fabricated numeric finding or rejected entirely.
  expect(
    validDossier.raids[0].bosses[0].firstKill.historicWorldRank
  ).toBeNull();
  const parsed = applicantDossierSchema.parse(validDossier).raids[0]?.bosses[0];
  expect(parsed?.state).toBe("kill");
  if (parsed?.state !== "kill") throw new Error("expected_verified_kill");
  expect(parsed.firstKill.historicWorldRank).toBeNull();
});

it("strictly validates applicant dossier parse summaries", () => {
  const available = {
    state: "available",
    percentile: 98.7,
    reportUrl: "https://www.warcraftlogs.com/reports/example#fight=9"
  };
  expect(
    applicantDossierSchema.safeParse(dossierWithParses(available)).success
  ).toBe(true);
  expect(
    applicantDossierSchema.safeParse(
      dossierWithParses({ state: "unavailable", percentile: 50 })
    ).success
  ).toBe(false);
  expect(
    applicantDossierSchema.safeParse(
      dossierWithParses({ state: "available", percentile: 50 })
    ).success
  ).toBe(false);
  expect(
    applicantDossierSchema.safeParse(
      dossierWithParses({ ...available, bracketPercent: 100 })
    ).success
  ).toBe(false);
  expect(
    applicantDossierSchema.safeParse(
      dossierWithParses({ ...available, percentile: 100.001 })
    ).success
  ).toBe(false);
  expect(
    applicantDossierSchema.safeParse(
      dossierWithParses({ ...available, percentile: -0.001 })
    ).success
  ).toBe(false);
});

it("defines a strict operator collection monitor without internal run fields", () => {
  const response = {
    generatedAt: "2026-09-20T12:00:00.000Z",
    hasActiveRuns: true,
    inFlight: [
      {
        character: applicantCharacter,
        status: "retrying",
        attempt: 2,
        startedAt: "2026-09-20T11:45:00.000Z",
        elapsedSeconds: 900,
        retryAfterAt: "2026-09-20T12:15:00.000Z"
      }
    ],
    completed: [
      {
        character: applicantCharacter,
        state: "partial",
        limitationCode: "request_cap",
        parseLimitationCode: null,
        completedAt: "2026-09-20T11:30:00.000Z",
        evidenceVersion: 13
      }
    ],
    hasMoreCompleted: false,
    failed: [
      {
        character: applicantCharacter,
        errorCode: "warcraft_logs_unavailable",
        stoppedAt: "2026-09-20T10:00:00.000Z"
      }
    ],
    discoveryRuns: [
      {
        character: applicantCharacter,
        status: "failed",
        attempt: 3,
        requestedAt: "2026-09-20T09:00:00.000Z",
        startedAt: "2026-09-20T09:00:01.000Z",
        completedAt: "2026-09-20T09:05:00.000Z",
        errorCode: "upstream_unavailable"
      }
    ]
  };

  expect(collectionMonitorResponseSchema.parse(response)).toEqual(response);
  expect(() =>
    collectionMonitorResponseSchema.parse({
      ...response,
      inFlight: [
        {
          ...response.inFlight[0],
          queueJobId: "private-queue-job"
        }
      ]
    })
  ).toThrow();
  expect(() =>
    collectionMonitorResponseSchema.parse({
      ...response,
      completed: [
        {
          ...response.completed[0],
          wclClientSecretEncrypted: "ciphertext"
        }
      ]
    })
  ).toThrow();
  expect(() =>
    collectionMonitorResponseSchema.parse({
      ...response,
      discoveryRuns: [
        {
          ...response.discoveryRuns[0],
          snapshotId: "private-snapshot"
        }
      ]
    })
  ).toThrow();
});
