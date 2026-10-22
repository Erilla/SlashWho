import type {
  BotDossierBoss,
  BotDossierCharacter,
  BotDossierGuildHistory,
  BotDossierLimitation,
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
  /** Limitations the payload will carry, including the skipped-subject cap. */
  limitations?: readonly { recovery: "automatic" | "none" }[];
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
    input.evidence.some((item) => item.limitations.length > 0) ||
    (input.limitations?.length ?? 0) > 0
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

/** The bot's own view stops at five tiers, so five raids is parity, not loss. */
const BOT_RAID_LIMIT = 5;

function keyId(key: CharacterKey): string {
  return `${key.region}\0${key.realm}\0${key.name}`;
}

/** A compact, unambiguous identity: two realms can share a character name. */
function identityOf(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

function uniqueIdentities(identities: readonly string[]): string[] {
  return [...new Set(identities)].sort();
}

/**
 * Spans the same way the page draws them: one-night guilds are pugs, renames
 * merge, and a whole-tier gap starts a new span. Each span's raids are the
 * distinct kill events inside the span, grouped by raid. One event can name
 * several characters, so counting rows would inflate the kill count.
 */
function guildHistoryOf(
  kills: readonly DossierKillEvidence[],
  identity: (key: CharacterKey) => string
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
    type KillEvent = { killedAt: string; characters: Set<string> };
    type RaidEvents = { raidName: string; events: Map<string, KillEvent> };
    const byRaid = new Map<string, RaidEvents>();
    for (const kill of kills) {
      if (!kill.guild) continue;
      if (guildIdentity(kill.guild) !== span.guildId) continue;
      const date = kill.killedAt.slice(0, 10);
      if (date < span.firstNight || date > span.lastNight) continue;
      nights.add(date);
      const raid: RaidEvents = byRaid.get(kill.raidId) ?? {
        raidName: kill.raidName,
        events: new Map<string, KillEvent>()
      };
      // A kill event is one boss at one moment; the characters present are
      // rows on the same event, not separate kills.
      const eventKey = `${kill.bossId}\0${kill.killedAt}`;
      const event = raid.events.get(eventKey) ?? {
        killedAt: kill.killedAt,
        characters: new Set<string>()
      };
      event.characters.add(identity(kill.character));
      raid.events.set(eventKey, event);
      byRaid.set(kill.raidId, raid);
    }
    return {
      guild: span.guild,
      firstNight: span.firstNight,
      lastNight: span.lastNight,
      raidNights: nights.size,
      tiers: [...span.tiers],
      characters: span.characters.map(identity),
      raids: [...byRaid.values()]
        .map((raid) => {
          const events = [...raid.events.values()];
          const times = events.map((event) => event.killedAt);
          return {
            raidName: raid.raidName,
            kills: events.length,
            firstKillAt: times.reduce((left, right) =>
              left < right ? left : right
            ),
            lastKillAt: times.reduce((left, right) =>
              left > right ? left : right
            ),
            characters: uniqueIdentities(
              events.flatMap((event) => [...event.characters])
            )
          };
        })
        .sort((left, right) => (left.firstKillAt < right.firstKillAt ? 1 : -1))
    };
  });
}

type RaidWithActivity = Readonly<{
  raid: BotDossierRaid;
  lastActivityAt: string;
}>;

function raidsOf(
  dossier: Extract<StoredDossierRead, { kind: "ready" }>["dossier"],
  identity: (key: CharacterKey) => string
): RaidWithActivity[] {
  const raids: RaidWithActivity[] = [];
  for (const raid of dossier.raids) {
    const bosses: BotDossierBoss[] = [];
    let hasKill = false;
    let lastActivityAt = "";
    for (const boss of raid.bosses) {
      if (boss.state === "kill" && boss.firstKill.characters.length > 0) {
        hasKill = true;
        if (boss.firstKill.killedAt > lastActivityAt) {
          lastActivityAt = boss.firstKill.killedAt;
        }
        bosses.push({
          bossName: boss.bossName,
          state: "kill",
          firstKilledAt: boss.firstKill.killedAt,
          characters: boss.firstKill.characters.map(identity),
          worldRank: boss.firstKill.historicWorldRank,
          reportUrl: boss.firstKill.reportUrl
        });
      } else if (boss.state === "wipe" && boss.wipe.characters.length > 0) {
        if (boss.wipe.attemptedAt > lastActivityAt) {
          lastActivityAt = boss.wipe.attemptedAt;
        }
        bosses.push({
          bossName: boss.bossName,
          state: "wipe",
          firstKilledAt: null,
          characters: boss.wipe.characters.map(identity),
          worldRank: null,
          reportUrl: boss.wipe.reportUrl
        });
      }
    }
    if (hasKill && bosses.length > 0) {
      raids.push({
        raid: { raidName: raid.raidName, bosses },
        lastActivityAt
      });
    }
  }
  return raids.sort((left, right) =>
    left.lastActivityAt < right.lastActivityAt ? 1 : -1
  );
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
    evidence: read.evidence,
    limitations: read.limitations
  });
  return {
    state,
    snapshotId: read.snapshotId,
    lastCollectedAt: lastCollectedAt?.toISOString() ?? null,
    evidenceRunIds: [...read.evidenceRunIds]
  };
}

function limitationsOf(
  limitations: readonly BotDossierLimitation[]
): BotDossierLimitation[] {
  return [
    ...new Map(
      limitations.map((limitation) => [
        `${limitation.code}\0${limitation.affects}\0${
          limitation.character ? keyId(limitation.character) : ""
        }`,
        limitation
      ])
    ).values()
  ];
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
      raidsTruncated: false,
      cuttingEdges: [],
      limitations: limitationsOf(
        read.evidence.flatMap((item) =>
          item.limitations.map((limitation) => ({
            code: limitation.code,
            affects: limitation.affects,
            character: limitation.character
          }))
        )
      )
    };
  }
  const limitations = limitationsOf([
    ...read.dossier.limitations.map((limitation) => ({
      code: limitation.code,
      affects: limitation.affects,
      character: limitation.character
    })),
    // `privacy_hidden` is a snapshot flag, not a public limitation. The bot
    // summary says why it is partial rather than publishing an empty list.
    ...(read.snapshotLimitationCode === "privacy_hidden"
      ? [
          {
            code: "privacy_hidden" as const,
            affects: "linked_characters" as const,
            character: read.dossier.root
          }
        ]
      : [])
  ]);
  const { state, lastCollectedAt } = botDossierState({
    snapshotId: read.snapshotId,
    snapshotState: read.snapshotState,
    activeDiscovery: read.activeDiscovery,
    evidenceRunIds: read.evidenceRunIds,
    evidence: read.evidence,
    limitations: read.limitations
  });
  const pending = new Set(read.pendingKeys.map((key) => keyId(key)));
  const allRaids = raidsOf(read.dossier, identityOf);
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
            (item) => keyId(item.key) === keyId(character.key)
          ),
          pending.has(keyId(character.key))
        )
      ),
    guildHistory: guildHistoryOf(read.kills, identityOf),
    raids: allRaids.slice(0, BOT_RAID_LIMIT).map((entry) => entry.raid),
    raidsTruncated: allRaids.length > BOT_RAID_LIMIT,
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
    limitations
  };
}
