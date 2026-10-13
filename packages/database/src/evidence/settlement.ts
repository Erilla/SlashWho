import type { CharacterKey } from "@slashwho/domain";
import type { Queryable } from "../sql";
import type {
  CompletedEvidenceSelection,
  EvidenceCollectionDomain,
  EvidenceRepository,
  EvidenceSchedulingReads,
  HistoricAliasScanProgress
} from "../repositories";
import { CURRENT_COLLECTION_VERSIONS } from "./freshness";
import {
  loadCompletedSettlementKills,
  loadSchedulingHydratedUrls
} from "./load";

export function createSharedSettlementReads(
  client: Queryable
): Pick<
  EvidenceRepository,
  "collectedTierZones" | "lastRaiderIoRecoveryAt" | "terminalTiers"
> {
  return {
    async collectedTierZones(key) {
      // Scoped exactly like `loadStoredTierBestParses`, which is the set
      // `publish` carries forward: a zone counts as collected only while its
      // rows survive into the next run's evidence. `completed_at` is the
      // run's, so a kill newer than it reopens the zone for collection.
      const result = await client.query<{
        raid_id: string;
        collected_at: Date;
      }>(
        `SELECT t.raid_id, max(t.collected_at) AS collected_at
             FROM character_tier_best_parses t
             JOIN character_evidence_runs r ON r.id = t.evidence_run_id
            WHERE r.region = $1 AND r.realm_slug = $2 AND r.normalized_name = $3
              AND r.status IN ('complete', 'partial')
            GROUP BY t.raid_id`,
        [key.region, key.realm, key.name]
      );
      return result.rows
        .map((row) => [row.raid_id, row.collected_at.toISOString()] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));
    },
    async lastRaiderIoRecoveryAt(key) {
      const result = await client.query<{ completed_at: Date | null }>(
        `SELECT max(run.completed_at) AS completed_at
             FROM character_evidence_run_costs cost
             JOIN character_evidence_runs run ON run.id = cost.run_id
            WHERE run.region = $1 AND run.realm_slug = $2
              AND run.normalized_name = $3
              AND run.status IN ('complete', 'partial')
              AND cost.raiderio_historic_outcome = 'evidence'`,
        [key.region, key.realm, key.name]
      );
      return result.rows[0]?.completed_at ?? null;
    },
    async terminalTiers(key) {
      const result = await client.query<{
        raid_id: string;
        domain: EvidenceCollectionDomain;
      }>(
        `SELECT raid_id, domain
             FROM character_terminal_tiers
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND collection_version >= CASE domain
                    WHEN 'kills' THEN $4::integer
                    WHEN 'parses' THEN $5::integer
                    ELSE $6::integer
                  END
            ORDER BY raid_id, domain`,
        [
          key.region,
          key.realm,
          key.name,
          CURRENT_COLLECTION_VERSIONS.kills,
          CURRENT_COLLECTION_VERSIONS.parses,
          CURRENT_COLLECTION_VERSIONS.tier_bests
        ]
      );
      return result.rows.map((row) => ({
        raidId: row.raid_id,
        domain: row.domain
      }));
    }
  };
}

export function createSchedulingReads(
  client: Queryable,
  selected: CompletedEvidenceSelection | null
): EvidenceSchedulingReads {
  return {
    ...createSharedSettlementReads(client),
    completedSettlementKills: (selection) =>
      loadCompletedSettlementKills(client, selection),
    hydratedFightUrls: (_key, before) =>
      loadSchedulingHydratedUrls(client, selected, before),
    async storedEvidenceTiers(key: CharacterKey) {
      const kills = selected
        ? await client.query<{ raid_id: string }>(
            `SELECT DISTINCT raid_id FROM character_mythic_kills WHERE evidence_run_id = $1`,
            [selected.snapshotRunId]
          )
        : { rows: [] };
      const wipes = selected
        ? await client.query<{ raid_id: string }>(
            `SELECT DISTINCT raid_id FROM character_mythic_wipes WHERE evidence_run_id = $1`,
            [selected.snapshotRunId]
          )
        : { rows: [] };
      const values = [key.region, key.realm, key.name];
      const scan = await client.query<{ completed_at: Date }>(
        `SELECT completed_at FROM character_evidence_runs
         WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
           AND kill_scan_skipped = false AND kill_scan_completed_at IS NOT NULL
         ORDER BY kill_scan_completed_at DESC LIMIT 1`,
        values
      );
      const resume = await client.query<{
        kill_scan_resume_page: number | null;
      }>(
        `SELECT kill_scan_resume_page FROM character_evidence_runs
         WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
           AND status IN ('complete', 'partial') AND kill_scan_skipped = false
         ORDER BY completed_at DESC, id DESC LIMIT 1`,
        values
      );
      const aliases = await client.query<{
        historic_alias_progress: HistoricAliasScanProgress[];
      }>(
        `SELECT historic_alias_progress FROM character_evidence_runs
         WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
           AND status IN ('complete', 'partial') AND historic_alias_progress IS NOT NULL
         ORDER BY completed_at DESC, id DESC LIMIT 1`,
        values
      );
      return {
        kills: kills.rows.map((row) => ({ raidId: row.raid_id })),
        wipes: wipes.rows.map((row) => ({ raidId: row.raid_id })),
        ...(scan.rows[0]?.completed_at
          ? { lastCleanKillScanAt: scan.rows[0].completed_at.toISOString() }
          : {}),
        ...(resume.rows[0]?.kill_scan_resume_page
          ? { historyScanResumePage: resume.rows[0].kill_scan_resume_page }
          : {}),
        historicAliasProgress: aliases.rows[0]?.historic_alias_progress ?? []
      };
    }
  };
}
