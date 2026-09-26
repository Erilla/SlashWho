import {
  isNonRaidZone,
  supportedRegions,
  type CharacterKey
} from "@slashwho/domain";

import { MYTHIC_DIFFICULTY } from "../queries";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsReportResult,
  WarcraftLogsWipeEvidence
} from "../types";
import {
  MAX_DATE_MILLISECONDS,
  nonEmptyString,
  nonNegativeInteger,
  normalizedRealm,
  positiveInteger,
  record,
  validTimestampMilliseconds
} from "./primitives";
import { unavailablePerformance } from "./rankings";

export type ReportSpan = Readonly<{ start: number; end: number }>;

/**
 * From a report's start to its last fight's end, for each report on a history
 * page. A verified kill inside one was either decoded from it or is not the
 * character's to claim from it, so attendance has nothing to add.
 */
export function reportSpans(
  value: unknown,
  omittedReportCodes: ReadonlySet<string> = new Set()
): readonly ReportSpan[] {
  return recentReportsData(value).flatMap((reportValue) => {
    const report = record(reportValue);
    const code = report && nonEmptyString(report.code);
    if (code && omittedReportCodes.has(code)) return [];
    const start = report && validTimestampMilliseconds(report.startTime);
    if (report === null || start === null || !Array.isArray(report.fights)) {
      return [];
    }
    let end = start;
    for (const fightValue of report.fights) {
      const fightEnd = validTimestampMilliseconds(record(fightValue)?.endTime);
      if (fightEnd !== null) end = Math.max(end, start + fightEnd);
    }
    return [{ start, end }];
  });
}

export function decodedHydratedReport(
  value: unknown,
  key: CharacterKey
): WarcraftLogsReportResult {
  const report = record(record(value)?.data)?.reportData;
  const reportValue = report && record(report)?.report;
  return firstKillReports(
    {
      data: {
        characterData: {
          character: {
            server: { normalizedName: key.realm },
            recentReports: {
              data: reportValue === null ? [] : [reportValue],
              has_more_pages: false
            }
          }
        }
      }
    },
    key
  );
}

export function firstKillReports(
  value: unknown,
  requestedKey: CharacterKey
): WarcraftLogsReportResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && characterData.character;
  if (character === null) return { kind: "limitation", code: "not_found" };

  const entry = record(character);
  const characterServer = entry && record(entry.server);
  const characterRealm =
    characterServer && nonEmptyString(characterServer.normalizedName);
  const recentReports = entry && record(entry.recentReports);
  const reports = recentReports && recentReports.data;
  const hasMorePages = recentReports && recentReports.has_more_pages;
  if (
    !characterRealm ||
    !Array.isArray(reports) ||
    typeof hasMorePages !== "boolean"
  ) {
    return { kind: "limitation", code: "schema_drift" };
  }

  const kills = new Map<string, WarcraftLogsFirstKillEvidence>();
  const wipes = new Map<string, WarcraftLogsWipeEvidence>();
  const killedByReportBoss = new Set<string>();
  let omittedInvalidTimestamp = false;
  const omittedInvalidTimestampReportCodes = new Set<string>();
  const schemaDrift = (): WarcraftLogsReportResult =>
    kills.size > 0 || wipes.size > 0 || omittedInvalidTimestamp
      ? {
          kind: "evidence",
          ...(omittedInvalidTimestamp
            ? {
                omittedInvalidTimestamp: true as const,
                omittedInvalidTimestampReportCodes: [
                  ...omittedInvalidTimestampReportCodes
                ]
              }
            : {}),
          kills: [...kills.values()],
          wipes: [...wipes.values()],
          tierBests: [],
          // This decodes one page of report history and reads no rankings at
          // all, so it has asked about nothing.
          parsedFightUrls: [],
          // One page's normalisation attributes trouble to no raid: the caller
          // owns that judgement across the whole read.
          troubledRaidIds: { parses: [], tierBests: [] },
          limitation: { kind: "limitation", code: "schema_drift" }
        }
      : { kind: "limitation", code: "schema_drift" };
  for (const reportValue of reports) {
    const report = record(reportValue);
    const code = report && nonEmptyString(report.code);
    const reportStartTime =
      report && validTimestampMilliseconds(report.startTime);
    const reportGuild = report && report.guild;
    const reportOwner = report && record(report.owner);
    const uploader = reportOwner ? nonEmptyString(reportOwner.name) : null;
    const fights = report && report.fights;
    const zone = report && record(report.zone);
    const raidId = zone && positiveInteger(zone.id);
    const raidName = zone && nonEmptyString(zone.name);
    const masterData = report && record(report.masterData);
    const actors = masterData && masterData.actors;
    if (
      !code ||
      reportStartTime === null ||
      !raidId ||
      !raidName ||
      !Array.isArray(actors) ||
      !Array.isArray(fights)
    ) {
      return schemaDrift();
    }

    let guild: WarcraftLogsFirstKillEvidence["guild"] = null;
    if (reportGuild !== null && reportGuild !== undefined) {
      const guildRecord = record(reportGuild);
      const guildServer = guildRecord && record(guildRecord.server);
      const guildRegion = guildServer && record(guildServer.region);
      const guildName = guildRecord && nonEmptyString(guildRecord.name);
      const guildRealm = guildServer && nonEmptyString(guildServer.slug);
      const guildRegionSlug = guildRegion && nonEmptyString(guildRegion.slug);
      const region = guildRegionSlug?.toLocaleLowerCase("en-US");
      if (
        !guildName ||
        !guildRealm ||
        !region ||
        !supportedRegions.includes(region as CharacterKey["region"])
      ) {
        return schemaDrift();
      }
      guild = {
        name: guildName,
        region: region as CharacterKey["region"],
        realm: guildRealm
      };
    }

    const journalBossIds = new Map<number, string>();
    const zoneEncounters = zone && zone.encounters;
    if (Array.isArray(zoneEncounters)) {
      for (const encounterValue of zoneEncounters) {
        const encounter = record(encounterValue);
        const encounterId = encounter && positiveInteger(encounter.id);
        const journalId = encounter && positiveInteger(encounter.journalID);
        if (encounterId && journalId) {
          journalBossIds.set(encounterId, String(journalId));
        }
      }
    }

    const participantIds = new Set<number>();
    for (const actorValue of actors) {
      const actor = record(actorValue);
      if (actor?.type !== "Player") continue;
      const actorId = actor && positiveInteger(actor.id);
      const name = actor && nonEmptyString(actor.name);
      const server = actor && nonEmptyString(actor.server);
      // An actor without a complete identity cannot establish this character's
      // participation. Ignore it rather than discarding other attributable
      // kills in the report.
      if (!actorId || !name || !server) continue;
      if (
        name.toLocaleLowerCase("en-US") === requestedKey.name &&
        normalizedRealm(server) === normalizedRealm(requestedKey.realm)
      ) {
        participantIds.add(actorId);
      }
    }

    for (const fightValue of fights) {
      const fight = record(fightValue);
      const id = fight && positiveInteger(fight.id);
      const encounterId = fight && nonNegativeInteger(fight.encounterID);
      const bossName = fight && nonEmptyString(fight.name);
      const killed = fight && fight.kill;
      const difficulty = fight && fight.difficulty;
      const friendlyPlayers = fight && fight.friendlyPlayers;
      // A report carries one zone, but a raid night that also ran Mythic+ is
      // filed under the dungeon season. Only the fight knows its own instance.
      const fightZone = fight && record(fight.gameZone);
      const fightRaidId =
        (fightZone && positiveInteger(fightZone.id)) ?? raidId;
      const fightRaidName =
        (fightZone && nonEmptyString(fightZone.name)) ?? raidName;
      if (!id || encounterId === null) {
        return schemaDrift();
      }
      // Warcraft Logs represents trash pulls with encounterID 0. They have no
      // boss identity and must not turn an otherwise valid report into schema
      // drift or dossier evidence.
      if (encounterId === 0) continue;
      if (
        typeof killed !== "boolean" ||
        !Number.isSafeInteger(difficulty) ||
        !Array.isArray(friendlyPlayers) ||
        friendlyPlayers.some((player) => !positiveInteger(player))
      ) {
        return schemaDrift();
      }
      if (
        difficulty !== MYTHIC_DIFFICULTY ||
        !friendlyPlayers.some((player) => participantIds.has(player))
      ) {
        continue;
      }
      const fightStartTime = validTimestampMilliseconds(fight.startTime);
      const fightEndTime = validTimestampMilliseconds(fight.endTime);
      if (
        fightStartTime === null ||
        fightEndTime === null ||
        fightEndTime < fightStartTime
      ) {
        omittedInvalidTimestamp = true;
        omittedInvalidTimestampReportCodes.add(code);
        continue;
      }
      // A Mythic dungeon boss carries the same difficulty as a Mythic raid
      // boss, so difficulty alone cannot say which fights are raid evidence.
      // Judged per fight rather than per report: a raid night that also ran a
      // dungeon keeps every raid fight in it. Only a positively identified
      // dungeon is dropped -- a zone in neither catalogue is a raid nobody can
      // place, and still collected, because silence there reads as "never
      // killed it" (#346).
      if (isNonRaidZone(fightRaidName)) continue;
      if (!bossName) return schemaDrift();

      const evidenceAtMilliseconds = reportStartTime + fightEndTime;
      if (
        !Number.isSafeInteger(evidenceAtMilliseconds) ||
        evidenceAtMilliseconds > MAX_DATE_MILLISECONDS
      ) {
        omittedInvalidTimestamp = true;
        omittedInvalidTimestampReportCodes.add(code);
        continue;
      }
      const evidenceAt = new Date(evidenceAtMilliseconds).toISOString();
      const reportUrl = `https://www.warcraftlogs.com/reports/${encodeURIComponent(code)}`;
      const fightUrl = `${reportUrl}#fight=${id}`;
      if (!killed) {
        const candidate: WarcraftLogsWipeEvidence = {
          raidId: String(fightRaidId),
          raidName: fightRaidName,
          bossId: String(encounterId),
          bossName,
          journalBossId: journalBossIds.get(encounterId) ?? null,
          bossOrder: encounterId,
          attemptedAt: evidenceAt,
          reportUrl,
          fightUrl,
          guild,
          uploader
        };
        wipes.set(candidate.fightUrl, candidate);
        continue;
      }
      const candidate: WarcraftLogsFirstKillEvidence = {
        raidId: String(fightRaidId),
        raidName: fightRaidName,
        bossId: String(encounterId),
        bossName,
        journalBossId: journalBossIds.get(encounterId) ?? null,
        bossOrder: encounterId,
        killedAt: evidenceAt,
        reportCode: code,
        fightId: id,
        difficulty,
        performance: unavailablePerformance(),
        reportUrl,
        fightUrl,
        guild,
        uploader
      };
      killedByReportBoss.add(`${candidate.reportUrl}\0${candidate.bossId}`);
      kills.set(candidate.fightUrl, candidate);
    }
  }

  const filteredWipes = [...wipes.values()].filter((wipe) => {
    const key = `${wipe.reportUrl}\0${wipe.bossId}`;
    return !killedByReportBoss.has(key);
  });

  return {
    kind: "evidence",
    ...(omittedInvalidTimestamp
      ? {
          omittedInvalidTimestamp: true as const,
          omittedInvalidTimestampReportCodes: [
            ...omittedInvalidTimestampReportCodes
          ]
        }
      : {}),
    tierBests: [],
    parsedFightUrls: [],
    troubledRaidIds: { parses: [], tierBests: [] },
    kills: [...kills.values()].sort(
      (a, b) =>
        a.bossOrder - b.bossOrder ||
        a.killedAt.localeCompare(b.killedAt) ||
        a.fightUrl.localeCompare(b.fightUrl)
    ),
    wipes: [...filteredWipes].sort(
      (a, b) =>
        a.raidId.localeCompare(b.raidId) ||
        a.bossOrder - b.bossOrder ||
        b.attemptedAt.localeCompare(a.attemptedAt) ||
        a.fightUrl.localeCompare(b.fightUrl)
    )
  };
}

/**
 * When every fight on one page of reports happened, whether or not any of it
 * became evidence.
 *
 * This is what the scan floor's early stop needs, and it is deliberately not
 * the same question as "what did this page contribute". A page reaches as far
 * back as the oldest fight on it -- a Mythic dungeon, a Normal raid, someone
 * else's pull -- and reports are paged newest first, so a page whose fights
 * all predate the floor means every later page does too.
 *
 * Deriving it from the emitted evidence instead is what made this its own
 * function: dropping non-raid fights would leave a dungeon-only page carrying
 * no dates at all, so it could no longer end the scan, and a history full of
 * Mythic+ would page straight past its floor (#346).
 */
export function reportPageReach(value: unknown): readonly string[] {
  const reached: string[] = [];
  for (const reportValue of recentReportsData(value)) {
    const report = record(reportValue);
    const reportStartTime =
      report && validTimestampMilliseconds(report.startTime);
    if (report === null || reportStartTime === null) continue;
    if (!Array.isArray(report.fights)) continue;
    for (const fightValue of report.fights) {
      const fight = record(fightValue);
      const fightEndTime = fight && validTimestampMilliseconds(fight.endTime);
      if (fightEndTime === null) continue;
      const at = reportStartTime + fightEndTime;
      // A date the scan cannot trust says nothing about how far it reached, so
      // it is left out rather than allowed to end the scan early.
      if (!Number.isSafeInteger(at) || at > MAX_DATE_MILLISECONDS) continue;
      reached.push(new Date(at).toISOString());
    }
  }
  return reached;
}

export function hasMoreReportPages(value: unknown): boolean | null {
  const recentReports = recentReportsOf(value);
  return recentReports && typeof recentReports.has_more_pages === "boolean"
    ? recentReports.has_more_pages
    : null;
}

export function lastReportCode(value: unknown): string | null {
  const reports = recentReportsData(value);
  return reports.length === 0
    ? null
    : nonEmptyString(record(reports.at(-1))?.code);
}

export function reportCodes(value: unknown): readonly string[] {
  return recentReportsData(value).flatMap((report) => {
    const code = nonEmptyString(record(report)?.code);
    return code ? [code] : [];
  });
}

function recentReportsOf(value: unknown): Record<string, unknown> | null {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && record(characterData.character);
  return character && record(character.recentReports);
}

export function recentReportsData(value: unknown): readonly unknown[] {
  const reports = recentReportsOf(value)?.data;
  return Array.isArray(reports) ? reports : [];
}
