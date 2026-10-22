import type {
  BotDossierBoss,
  BotDossierCharacter,
  BotDossierGuildHistory,
  BotDossierRaid,
  BotDossierState,
  BotDossierStatus,
  BotDossierSummary
} from "@slashwho/contracts";
import {
  collectGuildRaidNights,
  guildIdentity,
  guildTimelineSpans,
  raidTiers,
  type CharacterKey,
  type DossierKillEvidence
} from "@slashwho/domain";

import type {
  StoredDossierEvidence,
  StoredDossierRead,
  StoredDossierSnapshotState,
  StoredDossierStatus
} from "./applicant-dossier-service";

export type BotDossierStateInput = Readonly<{
  snapshotId: string | null;
  snapshotState: StoredDossierSnapshotState;
  activeDiscovery: boolean;
  evidenceRunIds: readonly string[];
  evidence: readonly StoredDossierEvidence[];
}>;

export type BotDossierStateResult = Readonly<{
  state: BotDossierState;
  lastCollectedAt: Date | null;
}>;

function earliest(evidence: readonly StoredDossierEvidence[]): Date | null {
  const times = evidence.flatMap((item) =>
    item.completedAt ? [item.completedAt.getTime()] : []
  );
  return times.length === 0 ? null : new Date(Math.min(...times));
}

/**
 * The bot's one state definition, shared by status and summary so they cannot
 * disagree. It is deliberately not `research.state`: that is derived from the
 * snapshot's own flags and can say `partial` forever for a privacy-hidden
 * snapshot, while the bot needs to know whether collection has settled.
 */
export function botDossierState(
  input: BotDossierStateInput
): BotDossierStateResult {
  const lastCollectedAt = earliest(input.evidence);
  if (
    input.snapshotId === null ||
    input.activeDiscovery ||
    input.evidenceRunIds.length > 0 ||
    input.evidence.some((item) => item.completedAt === null) ||
    input.evidence.some(
      (item) =>
        item.evidenceState === "waiting" || item.evidenceState === "scanning"
    )
  ) {
    return { state: "collecting", lastCollectedAt };
  }
  if (
    input.snapshotState === "partial" ||
    input.evidence.some((item) => item.evidenceState === "partial") ||
    input.evidence.some((item) => item.limitations.length > 0)
  ) {
    return { state: "partial", lastCollectedAt };
  }
  return { state: "ready", lastCollectedAt };
}

function sourceLabel(source: string): BotDossierCharacter["source"] {
  if (source === "submitted" || source === "manually_added") return source;
  if (source === "fingerprint_derived") return "fingerprint_derived";
  if (source === "raiderio_declared") return "raiderio_declared";
  // Discovery sources: `fingerprint` is the only one that is derived rather
  // than declared by Raider.IO.
  return source === "fingerprint" ? "fingerprint_derived" : "raiderio_declared";
}

function characterOf(
  subject: {
    key: CharacterKey;
    displayName: string;
    className: string | null;
    guild: {
      name: string;
      region: CharacterKey["region"];
      realm: string;
    } | null;
    source: string;
  },
  evidence: StoredDossierEvidence | undefined,
  pending: boolean
): BotDossierCharacter {
  return {
    key: subject.key,
    displayName: subject.displayName,
    className: subject.className,
    guild: subject.guild,
    source: sourceLabel(subject.source),
    confidence: null,
    evidenceState:
      evidence?.evidenceState === "scanning"
        ? "scanning"
        : evidence?.evidenceState === "complete"
          ? "complete"
          : evidence?.evidenceState === "partial"
            ? "partial"
            : "waiting",
    pending
  };
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/** The bot's own view stops at five tiers, so five raids is parity, not loss. */
const BOT_RAID_LIMIT = 5;

function keyId(key: CharacterKey): string {
  return `${key.region}\0${key.realm}\0${key.name}`;
}

/**
 * Spans the same way the page draws them: one-night guilds are pugs, renames
 * merge, and a whole-tier gap starts a new span. Each span's raids are the
 * stored kills inside the span, grouped by raid.
 */
function guildHistoryOf(
  kills: readonly DossierKillEvidence[],
  nameOf: (key: CharacterKey) => string
): BotDossierGuildHistory[] {
  const history = collectGuildRaidNights(
    kills.map((kill) => ({
      character: kill.character,
      killedAt: kill.killedAt,
      guild: kill.guild
    }))
  );
  return guildTimelineSpans(history, { tiers: raidTiers() }).map((span) => {
    const nights = new Set<string>();
    const byRaid = new Map<
      string,
      {
        raidName: string;
        kills: number;
        firstKillAt: string;
        lastKillAt: string;
        characters: CharacterKey[];
      }
    >();
    for (const kill of kills) {
      if (!kill.guild) continue;
      if (guildIdentity(kill.guild) !== span.guildId) continue;
      const date = kill.killedAt.slice(0, 10);
      if (date < span.firstNight || date > span.lastNight) continue;
      nights.add(date);
      const raid = byRaid.get(kill.raidId) ?? {
        raidName: kill.raidName,
        kills: 0,
        firstKillAt: kill.killedAt,
        lastKillAt: kill.killedAt,
        characters: []
      };
      raid.kills += 1;
      if (kill.killedAt < raid.firstKillAt) raid.firstKillAt = kill.killedAt;
      if (kill.killedAt > raid.lastKillAt) raid.lastKillAt = kill.killedAt;
      raid.characters.push(kill.character);
      byRaid.set(kill.raidId, raid);
    }
    return {
      guild: span.guild,
      firstNight: span.firstNight,
      lastNight: span.lastNight,
      raidNights: nights.size,
      tiers: [...span.tiers],
      characters: span.characters.map(nameOf),
      raids: [...byRaid.values()]
        .map((raid) => ({
          ...raid,
          characters: uniqueNames(raid.characters.map(nameOf))
        }))
        .sort((left, right) => (left.firstKillAt < right.firstKillAt ? 1 : -1))
    };
  });
}

function raidsOf(
  dossier: Extract<StoredDossierRead, { kind: "ready" }>["dossier"],
  nameOf: (key: CharacterKey) => string
): BotDossierRaid[] {
  const raids: BotDossierRaid[] = [];
  for (const raid of dossier.raids) {
    const bosses: BotDossierBoss[] = [];
    let hasKill = false;
    for (const boss of raid.bosses) {
      if (boss.state === "kill" && boss.firstKill.characters.length > 0) {
        hasKill = true;
        bosses.push({
          bossName: boss.bossName,
          state: "kill",
          firstKilledAt: boss.firstKill.killedAt,
          characters: boss.firstKill.characters.map(nameOf),
          worldRank: boss.firstKill.historicWorldRank,
          reportUrl: boss.firstKill.reportUrl
        });
      } else if (boss.state === "wipe" && boss.wipe.characters.length > 0) {
        bosses.push({
          bossName: boss.bossName,
          state: "wipe",
          firstKilledAt: null,
          characters: boss.wipe.characters.map(nameOf),
          worldRank: null,
          reportUrl: boss.wipe.reportUrl
        });
      }
    }
    if (hasKill && bosses.length > 0) {
      raids.push({
        raidName: raid.raidName,
        cuttingEdge: raid.cuttingEdge,
        bosses
      });
    }
  }
  return raids;
}

export function botDossierStatusOf(
  read: StoredDossierStatus
): Omit<BotDossierStatus, "etag"> | null {
  if (read.kind === "not_found") return null;
  const { state, lastCollectedAt } = botDossierState({
    snapshotId: read.snapshotId,
    snapshotState: read.snapshotState,
    activeDiscovery: read.activeDiscovery,
    evidenceRunIds: read.evidenceRunIds,
    evidence: read.evidence
  });
  return {
    state,
    snapshotId: read.snapshotId,
    lastCollectedAt: lastCollectedAt?.toISOString() ?? null,
    evidenceRunIds: [...read.evidenceRunIds]
  };
}

export function botDossierSummaryOf(
  read: StoredDossierRead
): BotDossierSummary | null {
  if (read.kind === "not_found") return null;
  if (read.kind === "collecting") {
    return {
      root: read.subjects[0]!.key,
      state: "collecting",
      snapshotId: null,
      lastCollectedAt: earliest(read.evidence)?.toISOString() ?? null,
      cuttingEdgesRestored: false,
      characters: read.subjects.map((subject, index) =>
        characterOf(subject, read.evidence[index], subject.pending === true)
      ),
      guildHistory: [],
      raids: [],
      cuttingEdges: [],
      limitations: []
    };
  }
  const { state, lastCollectedAt } = botDossierState({
    snapshotId: read.snapshotId,
    snapshotState: read.snapshotState,
    activeDiscovery: read.activeDiscovery,
    evidenceRunIds: read.evidenceRunIds,
    evidence: read.evidence
  });
  const pending = new Set(read.pendingKeys.map((key) => keyId(key)));
  const names = new Map(
    read.dossier.characters.map((character) => [
      keyId(character.key),
      character.displayName
    ])
  );
  const nameOf = (key: CharacterKey): string =>
    names.get(keyId(key)) ?? key.name;
  return {
    root: read.dossier.root,
    state,
    snapshotId: read.snapshotId,
    lastCollectedAt: lastCollectedAt?.toISOString() ?? null,
    cuttingEdgesRestored: read.cuttingEdgesRestored,
    characters: read.dossier.characters
      .filter((character) => character.excluded !== true)
      .map((character) =>
        characterOf(
          {
            key: character.key,
            displayName: character.displayName,
            className: character.className,
            guild: character.guild ?? null,
            source: character.source
          },
          read.evidence.find(
            (item) =>
              item.key.region === character.key.region &&
              item.key.realm === character.key.realm &&
              item.key.name === character.key.name
          ),
          pending.has(
            `${character.key.region}\0${character.key.realm}\0${character.key.name}`
          )
        )
      ),
    guildHistory: guildHistoryOf(read.kills, nameOf),
    raids: raidsOf(read.dossier, nameOf).slice(0, BOT_RAID_LIMIT),
    cuttingEdges: [
      ...new Map(
        read.dossier.cuttingEdges.map((edge) => [
          edge.achievementId,
          {
            achievementName: edge.achievementName,
            completedAt: edge.completedAt
          }
        ])
      ).values()
    ],
    limitations: [
      ...new Map(
        read.dossier.limitations.map((limitation) => [
          `${limitation.code}\0${limitation.affects}\0${
            limitation.character
              ? `${limitation.character.region}\0${limitation.character.realm}\0${limitation.character.name}`
              : ""
          }`,
          {
            code: limitation.code,
            affects: limitation.affects,
            character: limitation.character
          }
        ])
      ).values()
    ]
  };
}
