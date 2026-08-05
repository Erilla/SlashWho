import {
  characterResourceSchema,
  historicalSnapshotSchema,
  historyPageSchema,
  jobStatusResponseSchema,
  type Character,
  type CharacterResource,
  type HistoricalSnapshot,
  type HistoryPage,
  type JobStatusResponse,
  type PublicErrorCode
} from "@slashwho/contracts";
import type {
  DiscoveryRun,
  SnapshotHistoryPage,
  StoredSnapshot,
  StoredSnapshotCharacter
} from "@slashwho/database";
import { toCharacterPath, type CharacterKey } from "@slashwho/domain";

const errorMessages: Record<PublicErrorCode, string> = {
  invalid_character_url: "The character URL is invalid.",
  character_not_found: "The character was not found.",
  rate_limited: "Too many requests.",
  upstream_unavailable: "Character data is temporarily unavailable.",
  search_failed: "The search could not be completed.",
  suppressed_character: "The character was not found.",
  unauthorized: "Authentication failed.",
  trusted_client_ip_unavailable: "The trusted client boundary is unavailable."
};

function serializeCharacter(character: StoredSnapshotCharacter): Character {
  return {
    region: character.key.region,
    realm: character.key.realm,
    name: character.displayName,
    className: character.className,
    level: character.level,
    raiderIoUrl: character.raiderIoUrl
  };
}

function requireRoot(snapshot: StoredSnapshot): StoredSnapshotCharacter {
  const root = snapshot.characters.find(
    ({ key }) =>
      key.region === snapshot.rootKey.region &&
      key.realm === snapshot.rootKey.realm &&
      key.name === snapshot.rootKey.name
  );
  if (!root) throw new Error("snapshot_root_missing");
  return root;
}

export function serializeCharacterResource(
  snapshot: StoredSnapshot,
  activeRun: DiscoveryRun | null = null
): CharacterResource {
  const activeJob =
    activeRun && ["queued", "running", "retrying"].includes(activeRun.status)
      ? {
          jobId: activeRun.id,
          status: activeRun.status as "queued" | "running" | "retrying",
          statusUrl: `/api/v1/searches/${activeRun.id}`
        }
      : null;

  return characterResourceSchema.parse({
    character: serializeCharacter(requireRoot(snapshot)),
    snapshot: {
      id: snapshot.id,
      state: snapshot.state,
      refreshedAt: snapshot.refreshedAt.toISOString(),
      characterCount: snapshot.characters.length,
      characters: snapshot.characters.map(serializeCharacter)
    },
    activeJob
  });
}

export function serializeJobStatus(run: DiscoveryRun): JobStatusResponse {
  return jobStatusResponseSchema.parse({
    jobId: run.id,
    status: run.status,
    characterUrl: toCharacterPath(run.rootKey),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    retryAt: run.nextRetryAt?.toISOString() ?? null,
    error: run.errorCode
      ? { code: run.errorCode, message: errorMessages[run.errorCode] }
      : null
  });
}

export function serializeHistoryPage(
  key: CharacterKey,
  page: SnapshotHistoryPage
): HistoryPage {
  const characterUrl = toCharacterPath(key);
  return historyPageSchema.parse({
    items: page.items.map((item) => ({
      id: item.id,
      refreshedAt: item.refreshedAt.toISOString(),
      state: item.state,
      characterCount: item.characterCount,
      url: `/api/v1/characters/${key.region}/${key.realm}/${key.name}/history/${item.id}`,
      characterUrl
    })),
    nextCursor: page.nextCursor
  });
}

export function serializeSnapshot(
  snapshot: StoredSnapshot
): HistoricalSnapshot {
  return historicalSnapshotSchema.parse({
    id: snapshot.id,
    root: serializeCharacter(requireRoot(snapshot)),
    refreshedAt: snapshot.refreshedAt.toISOString(),
    state: snapshot.state,
    characters: snapshot.characters.map(serializeCharacter)
  });
}
