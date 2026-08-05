import type { DiscoveryRun, StoredSnapshot } from "@slashwho/database";
import { describe, expect, it } from "vitest";

import {
  serializeCharacterResource,
  serializeHistoryPage,
  serializeJobStatus,
  serializeSnapshot
} from "./serializers";

const key = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
const snapshot: StoredSnapshot = {
  id: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  rootKey: key,
  state: "partial",
  limitationCode: "private_owner",
  refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
  characterCount: 2,
  characters: [
    {
      characterId: "00000000-0000-4000-8000-000000000003",
      key,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
      source: "input",
      displayOrder: 0
    },
    {
      characterId: "00000000-0000-4000-8000-000000000004",
      key: { region: "us", realm: "area-52", name: "related" },
      displayName: "Related",
      className: "Priest",
      level: 80,
      raiderIoUrl: "https://raider.io/characters/us/area-52/related",
      source: "profile_guess",
      displayOrder: 1
    }
  ]
};

const run: DiscoveryRun = {
  id: "00000000-0000-4000-8000-000000000002",
  rootKey: key,
  rootCharacterId: "00000000-0000-4000-8000-000000000003",
  queueJobId: "private-queue-id",
  status: "retrying",
  callerClass: "bot",
  attempt: 4,
  nextRetryAt: new Date("2026-08-04T12:05:00.000Z"),
  errorCode: null,
  createdAt: new Date("2026-08-04T11:59:00.000Z"),
  startedAt: new Date("2026-08-04T12:00:00.000Z"),
  completedAt: null,
  snapshotId: null
};

describe("public serializers", () => {
  it("allowlists character fields and omits discovery provenance", () => {
    // Break caught: internal source, run, limitation, or storage fields could enter JSON.
    const resource = serializeCharacterResource(snapshot, run);

    expect(resource).toMatchObject({
      character: { name: "Ryii" },
      snapshot: {
        id: snapshot.id,
        state: "partial",
        refreshedAt: "2026-08-04T12:00:00.000Z",
        characterCount: 2
      },
      activeJob: { jobId: run.id, status: "retrying" }
    });
    expect(JSON.stringify(resource)).not.toMatch(
      /profile_guess|private_owner|displayOrder|characterId|runId|queueJobId/
    );
  });

  it("returns only safe lifecycle fields for job status", () => {
    // Break caught: caller class, attempts, queue IDs, or root persistence fields could leak.
    const resource = serializeJobStatus({
      ...run,
      status: "failed",
      completedAt: new Date("2026-08-04T12:06:00.000Z"),
      errorCode: "upstream_unavailable"
    });

    expect(resource).toMatchObject({
      jobId: run.id,
      status: "failed",
      retryAt: "2026-08-04T12:05:00.000Z",
      error: { code: "upstream_unavailable" }
    });
    expect(JSON.stringify(resource)).not.toMatch(
      /private-queue-id|callerClass|attempt|rootKey/
    );
  });

  it("serializes opaque history and historical membership through contracts", () => {
    // Break caught: history could expose persistence metadata or derive an unstable cursor.
    expect(
      serializeHistoryPage(key, {
        items: [
          {
            id: snapshot.id,
            refreshedAt: snapshot.refreshedAt,
            state: snapshot.state,
            characterCount: snapshot.characterCount
          }
        ],
        nextCursor: "opaque-db-cursor"
      })
    ).toEqual({
      items: [
        {
          id: snapshot.id,
          refreshedAt: "2026-08-04T12:00:00.000Z",
          state: "partial",
          characterCount: 2,
          url: `/api/v1/characters/eu/silvermoon/ryii/history/${snapshot.id}`,
          characterUrl: "/characters/eu/silvermoon/ryii"
        }
      ],
      nextCursor: "opaque-db-cursor"
    });
    expect(JSON.stringify(serializeSnapshot(snapshot))).not.toMatch(
      /profile_guess|private_owner|displayOrder|characterId|runId/
    );
  });
});
