import {
  canonicalCharacterId,
  deduplicateCharacters,
  type CharacterKey,
  type DiscoverySource
} from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  continuationCycleWrite,
  firstSweepCycleWrite,
  legacyResolveSubjects,
  liveSweepCompletionWrite,
  raiderIoPublicationWrite,
  replayCharacterGroups,
  type ReplayReport,
  type ResolvedSubjects,
  type SweepForWrite
} from "../../packages/application/src";
import { resolveGroupSubjects } from "../../packages/application/src/group-subjects";
import {
  loadCharacterGroupsAudit,
  type CharacterGroupsAudit,
  type ObservationWriteInput,
  type SnapshotCharacterInput
} from "../../packages/database/src";
import {
  admitSweep,
  observation,
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

const CONFIG = { DOSSIER_CHARACTER_CEILING: 50 };

const key = (name: string): CharacterKey => ({
  region: "eu",
  realm: "draenor",
  name
});

describe("character groups replay", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: TestRepositories;

  beforeAll(async () => {
    ({ pool, stop, repositories } = await startRepositoryDatabase());
  });
  beforeEach(async () => {
    await resetRepositoryTables(pool);
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_request_events,
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states,
      warcraft_logs_character_ids
      CASCADE`);
  });
  afterAll(async () => {
    await stop();
  });

  const connections = () => repositories.characterConnections!;

  /** A quarter of an hour from now, so every publication so far has settled. */
  const settled = () => new Date(Date.now() + 15 * 60_000);

  /** The full replay, as the command-line script runs it. */
  async function replay(now: Date = settled()): Promise<{
    audit: CharacterGroupsAudit;
    legacy: Map<string, ResolvedSubjects | null>;
    report: ReplayReport;
  }> {
    const audit = await loadCharacterGroupsAudit(pool, now);
    const legacy = new Map<string, ResolvedSubjects | null>();
    for (const root of audit.roots) {
      legacy.set(
        canonicalCharacterId(root),
        await legacyResolveSubjects(root, repositories, CONFIG)
      );
    }
    return {
      audit,
      legacy,
      report: replayCharacterGroups(audit, legacy, CONFIG)
    };
  }

  const member = (
    name: string,
    source: DiscoverySource
  ): SnapshotCharacterInput => observation(key(name), name, source);

  async function startRun(root: CharacterKey): Promise<string> {
    const run = await repositories.runs.createOrReuse(root, "anonymous");
    await repositories.runs.markRunning(run.id);
    return run.id;
  }

  /** The worker's post-commit write, and its recompute unless it died first. */
  async function write(
    input: ObservationWriteInput,
    options: { recompute?: boolean } = {}
  ): Promise<void> {
    const result = await connections().writeObservations(input);
    if (options.recompute !== false) {
      await connections().recomputeGroupsOf(result.changedCharacterIds);
    }
  }

  /** `snapshots.create`: a Raider.IO-only publication, `not_due` included. */
  async function publishRaiderIo(
    rootName: string,
    members: SnapshotCharacterInput[],
    options: { write?: boolean; recompute?: boolean } = {}
  ): Promise<string> {
    const root = key(rootName);
    const runId = await startRun(root);
    const characters = [observation(root, rootName), ...members];
    await repositories.snapshots.create({
      runId,
      rootKey: root,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date(),
      characters
    });
    if (options.write !== false) {
      await write(
        raiderIoPublicationWrite({
          runId,
          rootKey: root,
          characters,
          limitationCode: null
        }),
        options
      );
    }
    return runId;
  }

  /** `createAndFinishFingerprintSweep`: a first sweep cycle, both families. */
  async function publishFirstCycle(
    rootName: string,
    raiderIo: SnapshotCharacterInput[],
    sweep: SweepForWrite,
    options: { resumeAfter?: string } = {}
  ): Promise<{ runId: string; snapshotId: string; reservationId: string }> {
    const root = key(rootName);
    const runId = await startRun(root);
    const reservation = await admitSweep(repositories, runId, root);
    const raiderIoCharacters = [observation(root, rootName), ...raiderIo];
    const limitationCode =
      options.resumeAfter === undefined ? null : "fingerprint_sweep_capped";
    const snapshot =
      await repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId,
          rootKey: root,
          state: limitationCode === null ? "complete" : "partial",
          limitationCode,
          refreshedAt: new Date(),
          characters: deduplicateCharacters([
            ...raiderIoCharacters,
            ...sweep.characters
          ])
        },
        { ...reservation, limitationCode },
        {
          resumeAfter: options.resumeAfter ?? null,
          limitationCode: null,
          advanced: true
        }
      );
    await write(
      firstSweepCycleWrite({
        runId,
        rootKey: root,
        raiderIoCharacters,
        raiderIoLimitation: null,
        sweep,
        excludedTournamentIds: new Set(),
        reservationId: reservation.reservationId
      })
    );
    return {
      runId,
      snapshotId: snapshot.id,
      reservationId: reservation.reservationId
    };
  }

  async function characterId(name: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM characters
       WHERE region = 'eu' AND realm_slug = 'draenor' AND normalized_name = $1`,
      [name]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`no character row for ${name}`);
    return id;
  }

  async function ledgerOf(runId: string) {
    const result = await pool.query<{
      family: string;
      decision: string;
      reason: string;
    }>(
      `SELECT family, decision, reason FROM character_connection_write_log
       WHERE run_id = $1 ORDER BY id`,
      [runId]
    );
    return result.rows;
  }

  /** The maintenance pass, run to a completed cycle. */
  async function completeCycle(): Promise<void> {
    const result = await connections().recomputePass({ budgetMs: 30_000 });
    expect(result.cycleCompleted).toBe(true);
  }

  const details = (report: ReplayReport) =>
    [...report.failures, ...report.reports].map((finding) => finding.detail);

  it("1. passes two roots whose snapshots hold the same three characters", async () => {
    await publishRaiderIo("alpha", [
      member("bravo", "claimed"),
      member("charlie", "claimed")
    ]);
    await publishRaiderIo("bravo", [
      member("alpha", "claimed"),
      member("charlie", "claimed")
    ]);

    const { report } = await replay();
    expect(report.failures).toEqual([]);
    expect(report.counts).toMatchObject({ pages: 3, unchanged: 3, grew: 0 });
  });

  it("2. reports the smaller of two containing shapes as grown and the larger unchanged", async () => {
    await publishRaiderIo("papa", [member("quebec", "claimed")]);
    await publishRaiderIo("romeo", [
      member("papa", "claimed"),
      member("quebec", "claimed"),
      member("sierra", "claimed"),
      member("tango", "claimed")
    ]);

    const { report } = await replay();
    expect(report.failures).toEqual([]);
    const grew = report.reports
      .filter((finding) => finding.check === "grew")
      .map((finding) => finding.detail);
    expect(grew).toEqual(["3 more on eu/draenor/papa"]);
    expect(report.counts).toMatchObject({ pages: 5, grew: 1, unchanged: 4 });
  });

  it("3. never removes a manually connected character or its discoveries", async () => {
    await publishRaiderIo("oscar", [member("alpha", "claimed")]);
    await publishRaiderIo("tango", [member("mike", "claimed")]);
    await repositories.manualConnections.add(key("oscar"), key("tango"));
    await completeCycle();

    const { legacy, report } = await replay();
    const today = legacy.get(canonicalCharacterId(key("oscar")))!;
    expect(today.selected.map((subject) => subject.key.name).sort()).toEqual([
      "alpha",
      "mike",
      "oscar",
      "tango"
    ]);
    expect(report.failures).toEqual([]);
  });

  it("4. keeps fingerprint links through a not_due refresh, which writes Raider.IO only", async () => {
    const swept = await publishFirstCycle(
      "oscar",
      [member("alpha", "claimed")],
      {
        kind: "matched",
        characters: [member("foxtrot", "fingerprint")],
        skippedHistoricalGuilds: 0
      }
    );
    const notDue = await publishRaiderIo("oscar", [member("alpha", "claimed")]);

    const fingerprint = await pool.query<{ discovery_run_id: string }>(
      `SELECT discovery_run_id FROM character_connections
       WHERE kind = 'observed' AND source = 'fingerprint'`
    );
    expect(fingerprint.rows).toEqual([{ discovery_run_id: swept.runId }]);
    expect(await ledgerOf(notDue)).toEqual([
      { family: "raiderio", decision: "replaced", reason: "raiderio_complete" }
    ]);

    const { report } = await replay();
    expect(report.failures).toEqual([]);
    expect(report.coverage).toMatchObject({ raiderio_complete: 2, matched: 1 });
  });

  it("5. accounts for a capped first cycle and its continuation", async () => {
    const root = key("oscar");
    const first = await publishFirstCycle(
      "oscar",
      [],
      {
        kind: "capped",
        characters: [member("foxtrot", "fingerprint")],
        skippedHistoricalGuilds: 0
      },
      { resumeAfter: JSON.stringify(["eu", "draenor", "golf"]) }
    );
    const continuation = await admitSweep(repositories, first.runId, root);
    const later = [member("hotel", "fingerprint")];
    await repositories.snapshots.amendAndFinishFingerprintSweep(
      first.snapshotId,
      later,
      { ...continuation, runId: first.runId, limitationCode: null },
      { resumeAfter: null, limitationCode: null, advanced: true }
    );
    await write(
      continuationCycleWrite({
        runId: first.runId,
        rootKey: root,
        sweep: {
          kind: "matched",
          characters: later,
          skippedHistoricalGuilds: 0
        },
        reservationId: continuation.reservationId
      })
    );

    expect(await ledgerOf(first.runId)).toEqual([
      { family: "raiderio", decision: "replaced", reason: "raiderio_complete" },
      { family: "fingerprint", decision: "added_only", reason: "capped" },
      { family: "fingerprint", decision: "replaced", reason: "matched" }
    ]);
    const { report } = await replay();
    expect(report.failures).toEqual([]);
    expect(report.coverage).toMatchObject({
      capped: 1,
      matched: 1,
      sweep_publication: 2,
      sweep_first_cycle: 1,
      sweep_continuation: 1,
      sweep_seal: 1
    });
  });

  it("6. passes presence for a character both sources found", async () => {
    // Break caught: the write took the de-duplicated snapshot list, which
    // keeps a character both sources found as Raider.IO only, so its
    // fingerprint observation was never recorded. The write must record both
    // families, and presence must pass on either, since the snapshot keeps
    // only one source.
    await publishFirstCycle("oscar", [member("alpha", "claimed")], {
      kind: "matched",
      characters: [member("alpha", "fingerprint")],
      skippedHistoricalGuilds: 0
    });

    const sources = await pool.query<{ source: string }>(
      `SELECT source FROM character_connections WHERE kind = 'observed' ORDER BY source`
    );
    expect(sources.rows.map((row) => row.source)).toEqual([
      "claimed",
      "fingerprint"
    ]);
    const stored = await repositories.snapshots.getCurrent(key("oscar"));
    expect(
      stored!.characters.find((character) => character.key.name === "alpha")
        ?.source
    ).toBe("claimed");
    const { report } = await replay();
    expect(report.failures).toEqual([]);
  });

  it("7. accounts for a live-sweep completion that finds a new alt", async () => {
    // Break caught: publications took a run's root from `root_character_id`,
    // which a run completing against a live sweep's snapshot never sets, so
    // its Raider.IO row was never owed; and provenance must accept an alt no
    // snapshot of the observer holds.
    await publishRaiderIo("zulu", [member("november", "claimed")]);
    const live = await publishFirstCycle(
      "oscar",
      [member("alpha", "claimed")],
      {
        kind: "capped",
        characters: [member("foxtrot", "fingerprint")],
        skippedHistoricalGuilds: 0
      },
      { resumeAfter: JSON.stringify(["eu", "draenor", "golf"]) }
    );
    const completion = await startRun(key("oscar"));
    await repositories.runs.completeWithLiveSweepSnapshot(
      completion,
      live.snapshotId
    );
    await write(
      liveSweepCompletionWrite({
        runId: completion,
        rootKey: key("oscar"),
        characters: [
          observation(key("oscar"), "oscar"),
          member("alpha", "claimed"),
          member("november", "claimed")
        ]
      })
    );

    const { audit, report } = await replay();
    expect(audit.publications).toContainEqual(
      expect.objectContaining({
        kind: "run",
        runId: completion,
        observerId: await characterId("oscar")
      })
    );
    expect(report.failures).toEqual([]);
    expect(report.coverage).toMatchObject({ live_sweep_completion: 1 });
    expect(
      report.reports.filter((finding) => finding.check === "grew")
    ).toContainEqual({ check: "grew", detail: "2 more on eu/draenor/oscar" });
  });

  it("8. retracts nothing after an unread sweep", async () => {
    await publishFirstCycle("oscar", [], {
      kind: "matched",
      characters: [member("foxtrot", "fingerprint")],
      skippedHistoricalGuilds: 0
    });
    const unread = await publishFirstCycle("oscar", [], {
      kind: "matched",
      characters: [],
      unreadRoot: true,
      skippedHistoricalGuilds: 0
    });

    expect(await ledgerOf(unread.runId)).toEqual([
      { family: "raiderio", decision: "replaced", reason: "raiderio_complete" },
      { family: "fingerprint", decision: "added_only", reason: "unread" }
    ]);
    const fingerprint = await pool.query(
      `SELECT 1 FROM character_connections
       WHERE kind = 'observed' AND source = 'fingerprint'`
    );
    expect(fingerprint.rowCount).toBe(1);
    const { report } = await replay();
    expect(report.failures).toEqual([]);
  });

  it("9. never prints a suppressed member, root or manual target", async () => {
    await publishRaiderIo("oscar", [
      member("alpha", "claimed"),
      member("sierra", "claimed")
    ]);
    await publishRaiderIo("hotel", [member("bravo", "claimed")]);
    await publishRaiderIo("tango", []);
    await repositories.manualConnections.add(key("oscar"), key("tango"));
    await completeCycle();
    for (const name of ["sierra", "hotel", "tango"]) {
      await repositories.suppressions.suppress(key(name), "test", null);
    }
    const hidden = ["sierra", "hotel", "tango"];

    const first = await replay();
    expect(first.report.failures).toEqual([]);
    expect(first.audit.roots.map((root) => root.name).sort()).toEqual([
      "alpha",
      "bravo",
      "oscar"
    ]);
    for (const detail of details(first.report)) {
      for (const name of hidden) expect(detail).not.toContain(name);
    }

    // A lost write for the suppressed root: the finding must name it only as
    // suppressed. A suppressed root cannot publish, so the lost publication
    // lands in a gap in its suppression.
    await pool.query(
      `DELETE FROM suppressed_characters WHERE normalized_name = 'hotel'`
    );
    const lost = await publishRaiderIo("hotel", [member("bravo", "claimed")], {
      write: false
    });
    await repositories.suppressions.suppress(key("hotel"), "test", null);
    const second = await replay();
    expect(second.report.failures).toEqual([
      { check: "a_completeness", detail: `run ${lost} for (suppressed)` }
    ]);
    for (const detail of details(second.report)) {
      for (const name of hidden) expect(detail).not.toContain(name);
    }
  });

  it("10. skips a publication a minute old whose write is still pending", async () => {
    const earlier = await publishRaiderIo("oscar", [
      member("alpha", "claimed")
    ]);
    await pool.query(
      `UPDATE discovery_runs SET completed_at = now() - interval '1 hour' WHERE id = $1`,
      [earlier]
    );
    const pending = await publishRaiderIo(
      "oscar",
      [member("alpha", "claimed"), member("charlie", "claimed")],
      { write: false }
    );

    const minuteLater = await replay(new Date(Date.now() + 60_000));
    expect(minuteLater.report.failures).toEqual([]);
    expect(minuteLater.report.counts).toMatchObject({ pendingPages: 3 });

    // Once it has had its 10 minutes, the same state is a lost write.
    const settledReplay = await replay();
    expect(settledReplay.report.failures).toContainEqual(
      expect.objectContaining({
        check: "a_completeness",
        detail: expect.stringContaining(pending)
      })
    );
  });

  it("11. follows a historic alias's excluded state, whichever key leads the identity", async () => {
    // One Warcraft Logs identity under a discovered-excluded key (zulu) and a
    // manual-excluded key (alfa). Today's read leads with zulu, the group
    // read with alfa, so only a comparison by identity set passes.
    await publishRaiderIo("alfa", []);
    await publishRaiderIo("oscar", [member("zulu", "claimed")]);
    await repositories.manualConnections.add(key("oscar"), key("alfa"));
    await repositories.manualConnections.setExcluded(
      key("oscar"),
      key("alfa"),
      true
    );
    await repositories.manualConnections.setDiscoveredExcluded!(
      key("oscar"),
      key("zulu"),
      true
    );
    const at = new Date();
    await repositories.evidence.recordWarcraftLogsCharacterId(
      key("alfa"),
      4242,
      at
    );
    await repositories.evidence.recordWarcraftLogsCharacterId(
      key("zulu"),
      4242,
      at
    );
    await completeCycle();

    const { audit, legacy, report } = await replay();
    const today = legacy.get(canonicalCharacterId(key("oscar")))!;
    expect(
      today.excludedOrdered.map((subject) => [
        subject.key.name,
        subject.warcraftLogsAliases?.map((alias) => alias.name)
      ])
    ).toEqual([["zulu", ["alfa"]]]);
    const next = resolveGroupSubjects(key("oscar"), audit.graph, CONFIG)!;
    expect(
      next.excluded.map((subject) => [
        subject.key.name,
        subject.warcraftLogsAliases?.map((alias) => alias.name)
      ])
    ).toEqual([["alfa", ["zulu"]]]);
    expect(report.failures).toEqual([]);
  });

  it("12. reports a sibling's discovered exclusion as shared, beside a manual one", async () => {
    await publishRaiderIo("oscar", [
      member("papa", "claimed"),
      member("xray", "claimed")
    ]);
    await publishRaiderIo("papa", [
      member("oscar", "claimed"),
      member("xray", "claimed")
    ]);
    await publishRaiderIo("tango", []);
    await repositories.manualConnections.add(key("oscar"), key("tango"));
    await repositories.manualConnections.setExcluded(
      key("oscar"),
      key("tango"),
      true
    );
    await repositories.manualConnections.setDiscoveredExcluded!(
      key("papa"),
      key("xray"),
      true
    );
    await completeCycle();

    const { report } = await replay();
    expect(report.failures).toEqual([]);
    const shared = report.reports.filter(
      (finding) => finding.check === "shared_exclusion"
    );
    expect(shared).toContainEqual({
      check: "shared_exclusion",
      detail: "eu/draenor/xray on eu/draenor/oscar"
    });
    expect(shared).toContainEqual({
      check: "shared_exclusion",
      detail: "eu/draenor/tango on eu/draenor/papa"
    });
  });

  it("13. fails a publication whose worker died between the snapshot commit and the write", async () => {
    // Break caught: a publication whose write never ran leaves nothing behind
    // but a missing ledger row, and its members still carry the previous
    // run's observations, so only (a) can see it.
    await publishRaiderIo("oscar", [member("alpha", "claimed")]);
    const lost = await publishRaiderIo("oscar", [member("alpha", "claimed")], {
      write: false
    });

    const { report } = await replay();
    expect(report.failures).toEqual([
      { check: "a_completeness", detail: `run ${lost} for eu/draenor/oscar` }
    ]);
  });

  it("14. reports drift as pending when the worker died between the write and the recompute, until a cycle recomputes it", async () => {
    // Break caught: the group a write merged into was never recomputed, and
    // drift failed at once instead of waiting for the maintenance cycle that
    // is the guaranteed backstop.
    await publishRaiderIo("oscar", [member("alpha", "claimed")]);
    await publishRaiderIo("zulu", [member("bravo", "claimed")]);
    await publishRaiderIo(
      "oscar",
      [member("alpha", "claimed"), member("zulu", "claimed")],
      { recompute: false }
    );

    const before = await replay();
    expect(before.report.failures).toEqual([]);
    expect(
      before.report.reports.filter((finding) =>
        finding.check.startsWith("drift")
      )
    ).toEqual([expect.objectContaining({ check: "drift_pending" })]);

    await completeCycle();
    const after = await replay();
    expect(after.report.failures).toEqual([]);
    expect(
      after.report.reports.filter((finding) =>
        finding.check.startsWith("drift")
      )
    ).toEqual([]);
  });
});
