import { describe, expect, it } from "vitest";
import type {
  CharacterGroupsAudit,
  CharacterGroupsLedgerRow,
  CharacterGroupsObservation,
  CharacterGroupsPublication,
  StoredSnapshot
} from "@slashwho/database";
import {
  canonicalCharacterId,
  type CharacterKey,
  type GroupGraph
} from "@slashwho/domain";
import {
  auditDrift,
  auditLedger,
  comparePages,
  replayCharacterGroups
} from "./character-groups-replay";
import type { RankedSubject, ResolvedSubjects } from "./dossier-subjects";
import type { GroupSubjects } from "./group-subjects";

const CONFIG = { DOSSIER_CHARACTER_CEILING: 50 };

describe("ledger checks", () => {
  it("(a) fails a publication with no ledger row, and skips one younger than 10 minutes", () => {
    const audit = baseAudit({
      ledger: [backfill("o", "raiderio", minutesAgo(600))],
      publications: [
        { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(60) },
        { kind: "run", runId: "r2", observerId: "o", at: minutesAgo(5) }
      ]
    });
    expect(auditLedger(audit).failures).toEqual([
      expect.objectContaining({
        check: "a_completeness",
        detail: expect.stringContaining("r1")
      })
    ]);
  });

  it("(a) matches a sweep publication by reservation id, cycle 1 included", () => {
    const audit = baseAudit({
      ledger: [
        backfill("o", "raiderio", minutesAgo(600)),
        ledgerRow({ runId: "r1", family: "raiderio" }),
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          sweepReservationId: "res1"
        })
      ],
      publications: [
        { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(60) },
        {
          kind: "reservation",
          reservationId: "res1",
          runId: "r1",
          observerId: "o",
          at: minutesAgo(60),
          limitationCode: null
        }
      ]
    });
    expect(auditLedger(audit).failures).toEqual([]);
  });

  it("(a) fails a published reservation whose run has only a Raider.IO row", () => {
    // Break caught: matching a reservation by its run id let a lost
    // continuation cycle hide behind cycle 1's Raider.IO row.
    const audit = baseAudit({
      ledger: [ledgerRow({ runId: "r1", family: "raiderio" })],
      publications: [
        {
          kind: "reservation",
          reservationId: "res2",
          runId: "r1",
          observerId: "o",
          at: minutesAgo(60),
          limitationCode: null
        }
      ]
    });
    expect(auditLedger(audit).failures).toEqual([
      expect.objectContaining({
        check: "a_completeness",
        detail: expect.stringContaining("res2")
      })
    ]);
  });

  it("(a) names a lost continuation even when its run's first cycle wrote both families", () => {
    // Break caught: matching a reservation by its run and any fingerprint
    // row let a lost continuation hide behind cycle 1's fingerprint row.
    const audit = baseAudit({
      graph: graphOf({ names: ["o"] }),
      ledger: [
        backfill("o", "raiderio", minutesAgo(600)),
        ledgerRow({ runId: "r1", family: "raiderio" }),
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          sweepReservationId: "res1"
        })
      ],
      publications: [
        { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(60) },
        reservation("res1", "r1", minutesAgo(60)),
        reservation("res2", "r1", minutesAgo(40))
      ]
    });
    expect(auditLedger(audit).failures).toEqual([
      { check: "a_completeness", detail: "reservation res2 for eu/draenor/o" }
    ]);
  });

  it("(a) starts its window at the newest backfill or rebuild row", () => {
    const audit = baseAudit({
      ledger: [
        ledgerRow({
          runId: "rb",
          family: "raiderio",
          reason: "rebuild",
          writtenAt: minutesAgo(30)
        })
      ],
      publications: [
        {
          kind: "run",
          runId: "lost-before-rebuild",
          observerId: "o",
          at: minutesAgo(90)
        }
      ]
    });
    expect(auditLedger(audit).failures).toEqual([]);
  });

  it("(b) passes when a snapshot member has an observation in either family, and ignores the root", () => {
    const audit = baseAudit({
      latestRawMembership: new Map([["o", ["o", "a"]]]),
      observations: [observationRow("o", "a", "fingerprint", "r1")],
      ledger: [ledgerRow({ runId: "r1", family: "fingerprint" })]
    });
    expect(auditLedger(audit).failures).toEqual([]);
  });

  it("(b) fails a member with no observation from its root, unless the root published under 10 minutes ago", () => {
    const missing = baseAudit({
      latestRawMembership: new Map([["o", ["o", "a"]]]),
      publications: [
        { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(60) }
      ],
      ledger: [ledgerRow({ runId: "r1", family: "raiderio" })]
    });
    expect(auditLedger(missing).failures).toEqual([
      expect.objectContaining({ check: "b_presence" })
    ]);
    const young = baseAudit({
      latestRawMembership: new Map([["o", ["o", "a"]]]),
      publications: [
        { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(1) }
      ]
    });
    expect(auditLedger(young).failures).toEqual([]);
  });

  it("(c) fails an observation whose run has no ledger row", () => {
    const audit = baseAudit({
      observations: [observationRow("o", "a", "claimed", "ghost")]
    });
    expect(
      auditLedger(audit).failures.map((finding) => finding.check)
    ).toContain("c_provenance");
  });

  it("(c) needs the ledger row in the observation's own family", () => {
    const audit = baseAudit({
      observations: [observationRow("o", "a", "fingerprint", "r1")],
      ledger: [ledgerRow({ runId: "r1", family: "raiderio" })]
    });
    expect(auditLedger(audit).failures.map((finding) => finding.check)).toEqual(
      ["c_provenance"]
    );
  });

  it("(d) applies the newest replaced row even after a later added_only row", () => {
    // Break caught: a later privacy-hidden run made (d) vacuous.
    const audit = baseAudit({
      ledger: [
        ledgerRow({
          runId: "r1",
          family: "raiderio",
          decision: "replaced",
          runStartedAt: minutesAgo(120)
        }),
        ledgerRow({
          runId: "r2",
          family: "raiderio",
          decision: "added_only",
          reason: "privacy_hidden",
          runStartedAt: minutesAgo(60)
        })
      ],
      observations: [observationRow("o", "stale", "claimed", "r0")]
    });
    expect(
      auditLedger(audit).failures.map((finding) => finding.check)
    ).toContain("d_retraction");
  });

  it("(d) keeps a row observed after the replacing run started, as the writer does", () => {
    // The writer never retracts a row observed after its own run started, so
    // a row an earlier-started run wrote after that start legitimately
    // survives the retraction.
    const audit = baseAudit({
      ledger: [
        ledgerRow({
          runId: "r0",
          family: "raiderio",
          runStartedAt: minutesAgo(130),
          writtenAt: minutesAgo(100)
        }),
        ledgerRow({
          runId: "r1",
          family: "raiderio",
          decision: "replaced",
          runStartedAt: minutesAgo(120),
          writtenAt: minutesAgo(90)
        })
      ],
      observations: [
        observationRow("o", "late", "claimed", "r0", minutesAgo(100))
      ]
    });
    expect(auditLedger(audit).failures).toEqual([]);
  });

  it("(d) does not credit a later run whose only row was blocked", () => {
    const audit = baseAudit({
      ledger: [
        ledgerRow({
          runId: "r1",
          family: "raiderio",
          decision: "replaced",
          runStartedAt: minutesAgo(120)
        }),
        ledgerRow({
          runId: "r2",
          family: "raiderio",
          decision: "blocked",
          reason: "blocked_by_newer",
          runStartedAt: minutesAgo(60)
        })
      ],
      observations: [observationRow("o", "stale", "claimed", "r2")]
    });
    expect(auditLedger(audit).failures.map((finding) => finding.check)).toEqual(
      ["d_retraction"]
    );
  });

  it("reports path coverage", () => {
    const audit = baseAudit({
      ledger: [
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          reason: "capped",
          sweepReservationId: "res"
        }),
        ledgerRow({
          runId: "r2",
          family: "raiderio",
          reason: "live_sweep_completion"
        })
      ]
    });
    expect(auditLedger(audit).coverage).toMatchObject({
      capped: 1,
      live_sweep_completion: 1
    });
  });

  it("counts a not_due refresh: a Raider.IO-only row from an observer swept before", () => {
    const audit = baseAudit({
      ledger: [
        backfill("o", "raiderio", minutesAgo(600)),
        // Before o was ever swept: a plain Raider.IO-only run.
        ledgerRow({
          runId: "r0",
          family: "raiderio",
          reason: "raiderio_complete",
          writtenAt: minutesAgo(400)
        }),
        // o's first sweep cycle, both families under one run.
        ledgerRow({
          runId: "r1",
          family: "raiderio",
          reason: "raiderio_complete",
          writtenAt: minutesAgo(300)
        }),
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          reason: "matched",
          sweepReservationId: "res1",
          writtenAt: minutesAgo(300)
        }),
        // The not_due refreshes, each reason once.
        ...["raiderio_complete", "raiderio_limited", "privacy_hidden"].map(
          (reason, index) =>
            ledgerRow({
              runId: `r${2 + index}`,
              family: "raiderio",
              reason,
              writtenAt: minutesAgo(200 - index)
            })
        ),
        // A live-sweep completion is not one.
        ledgerRow({
          runId: "r5",
          family: "raiderio",
          reason: "live_sweep_completion",
          writtenAt: minutesAgo(100)
        }),
        // Nor is another observer's Raider.IO-only run, never swept.
        ledgerRow({
          runId: "r6",
          observerId: "p",
          family: "raiderio",
          reason: "raiderio_complete",
          writtenAt: minutesAgo(90)
        }),
        // Nor is a later sweep's first cycle, though o was swept before it.
        ledgerRow({
          runId: "r7",
          family: "raiderio",
          reason: "raiderio_complete",
          writtenAt: minutesAgo(50)
        }),
        ledgerRow({
          runId: "r7",
          family: "fingerprint",
          reason: "matched",
          sweepReservationId: "res7",
          writtenAt: minutesAgo(50)
        })
      ]
    });
    expect(auditLedger(audit).coverage).toMatchObject({ not_due_refresh: 3 });
  });

  it("takes an observer's baseline fingerprint row as a sweep before a not_due refresh", () => {
    const audit = baseAudit({
      ledger: [
        backfill("o", "fingerprint", minutesAgo(600)),
        backfill("o", "raiderio", minutesAgo(600)),
        ledgerRow({
          runId: "r1",
          family: "raiderio",
          reason: "raiderio_complete",
          writtenAt: minutesAgo(100)
        })
      ]
    });
    expect(auditLedger(audit).coverage).toMatchObject({ not_due_refresh: 1 });
  });

  it("counts a seal by its reservation, whatever the ledger reason says", () => {
    // Break caught: a seal whose chain skipped a guild is logged
    // `skipped_guild`, and a blocked one `blocked_by_newer`, so counting by
    // reason missed both; and a capped cycle can carry `skipped_guild` too.
    const chain = (
      runId: string,
      last: { reason: string; decision?: string; limitationCode: string | null }
    ) => ({
      ledger: [
        ledgerRow({
          runId,
          family: "fingerprint",
          reason: "capped",
          sweepReservationId: `${runId}-1`,
          writtenAt: minutesAgo(50)
        }),
        ledgerRow({
          runId,
          family: "fingerprint",
          reason: last.reason,
          decision: last.decision ?? "added_only",
          sweepReservationId: `${runId}-2`,
          writtenAt: minutesAgo(40)
        })
      ],
      publications: [
        reservation(`${runId}-1`, runId, minutesAgo(50)),
        reservation(`${runId}-2`, runId, minutesAgo(40), last.limitationCode)
      ]
    });
    const coverageOf = (...chains: ReturnType<typeof chain>[]) =>
      auditLedger(
        baseAudit({
          ledger: [
            backfill("o", "fingerprint", minutesAgo(600)),
            ...chains.flatMap((c) => c.ledger)
          ],
          publications: chains.flatMap((c) => c.publications)
        })
      ).coverage;

    expect(
      coverageOf(
        chain("skip", { reason: "skipped_guild", limitationCode: null })
      )
    ).toMatchObject({ sweep_seal: 1 });
    expect(
      coverageOf(
        chain("blocked", {
          reason: "blocked_by_newer",
          decision: "blocked",
          limitationCode: "raiderio_limited"
        })
      )
    ).toMatchObject({ sweep_seal: 1 });
    expect(
      coverageOf(
        chain("capped", {
          reason: "skipped_guild",
          limitationCode: "fingerprint_sweep_capped"
        })
      ).sweep_seal
    ).toBeUndefined();
  });

  it("counts sweep publications by cycle: first, continuation and seal", () => {
    const audit = baseAudit({
      publications: [
        reservation("res1", "r1", minutesAgo(50)),
        reservation("res2", "r1", minutesAgo(40)),
        reservation("res3", "r1", minutesAgo(30), null)
      ],
      ledger: [
        backfill("o", "fingerprint", minutesAgo(600)),
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          reason: "capped",
          sweepReservationId: "res1",
          writtenAt: minutesAgo(50)
        }),
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          reason: "capped",
          sweepReservationId: "res2",
          writtenAt: minutesAgo(40)
        }),
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          decision: "replaced",
          reason: "matched",
          sweepReservationId: "res3",
          writtenAt: minutesAgo(30)
        })
      ]
    });
    expect(auditLedger(audit).coverage).toEqual({
      capped: 2,
      matched: 1,
      sweep_publication: 3,
      sweep_first_cycle: 1,
      sweep_continuation: 2,
      sweep_seal: 1
    });
  });

  it("counts manual connections made in the window as manual_added", () => {
    const audit = baseAudit({
      ledger: [backfill("o", "raiderio", minutesAgo(600))],
      manualCreatedAt: [minutesAgo(700), minutesAgo(30), minutesAgo(10)]
    });
    expect(auditLedger(audit).coverage).toMatchObject({ manual_added: 2 });
  });

  it("never prints a suppressed observer's key", () => {
    const audit = baseAudit({
      graph: graphOf({ names: ["hidden"], suppressed: new Set(["hidden"]) }),
      latestRawMembership: new Map([["hidden", ["hidden", "other"]]]),
      publications: [
        { kind: "run", runId: "r1", observerId: "hidden", at: minutesAgo(60) }
      ]
    });
    const details = auditLedger(audit).failures.map(
      (finding) => finding.detail
    );
    expect(details).toHaveLength(2);
    for (const detail of details) {
      expect(detail).toContain("(suppressed)");
      expect(detail).not.toContain("hidden");
    }
  });
});

describe("drift", () => {
  it("treats a group whose write is newer than its recompute as pending until a later cycle completes", () => {
    const audit = pendingDriftAudit({ cycleStartedAfterWrite: false });
    expect(auditDrift(audit)).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(
      auditDrift(pendingDriftAudit({ cycleStartedAfterWrite: true })).failures
    ).toEqual([expect.objectContaining({ check: "drift" })]);
  });

  it("reports drift from manual links alone, and fails other drift", () => {
    expect(auditDrift(manualOnlyDriftAudit()).failures).toEqual([]);
    expect(auditDrift(manualOnlyDriftAudit()).reports).toEqual([
      expect.objectContaining({ check: "drift_manual" })
    ]);
  });

  it("fails a missed split across a pair some published snapshot once observed", () => {
    // Break caught: a retraction deletes its row just as a manual removal
    // does, so judging by the current links called every missed split
    // manual, and it never failed.
    const retracted = baseAudit({
      ...manualOnlyDriftAudit(),
      observedEver: new Map([["o", new Set(["t"])]])
    });
    expect(auditDrift(retracted)).toEqual({
      failures: [expect.objectContaining({ check: "drift" })],
      reports: []
    });
    // Observed the other way round, from the other part's root, too.
    const fromTarget = baseAudit({
      ...manualOnlyDriftAudit(),
      observedEver: new Map([["t", new Set(["o"])]])
    });
    expect(auditDrift(fromTarget).failures).toEqual([
      expect.objectContaining({ check: "drift" })
    ]);
  });

  it("bounds pending drift by the measured cycle: an hour plus twice the last cycle's length", () => {
    // Break caught: a fixed 2 h bound false-failed a cycle that needs more
    // than one hourly pass. The last cycle took 90 minutes, so the bound is
    // 1 h + 2 × 90 min = 4 h.
    const at = (writtenAt: Date) =>
      groupDriftAudit({
        writtenAt,
        recomputedAt: minutesAgo(500),
        maintenance: {
          lastCycleStartedAt: minutesAgo(400),
          lastCycleCompletedAt: minutesAgo(310)
        }
      });
    expect(auditDrift(at(minutesAgo(239)))).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(auditDrift(at(minutesAgo(241))).failures).toEqual([
      {
        check: "drift_stale_pending",
        detail: "2 characters around eu/draenor/a, pending over 240 minutes"
      }
    ]);
  });

  it("clamps the measured cycle at six hours, so a 20 h cycle still bounds drift at 13 h", () => {
    // Break caught: a cycle that straddled a worker outage measured 20 h,
    // and the unclamped bound of 1 h + 2 × 20 h = 41 h hid the next stall.
    const at = (writtenAt: Date) =>
      groupDriftAudit({
        writtenAt,
        recomputedAt: minutesAgo(3_000),
        maintenance: {
          lastCycleStartedAt: minutesAgo(2_000),
          lastCycleCompletedAt: minutesAgo(800)
        }
      });
    expect(auditDrift(at(minutesAgo(779)))).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(auditDrift(at(minutesAgo(781))).failures).toEqual([
      {
        check: "drift_stale_pending",
        detail: "2 characters around eu/draenor/a, pending over 780 minutes"
      }
    ]);
  });

  it("keeps a two-hour floor on the bound when the last cycle was short", () => {
    const at = (writtenAt: Date) =>
      groupDriftAudit({
        writtenAt,
        recomputedAt: minutesAgo(500),
        maintenance: {
          lastCycleStartedAt: minutesAgo(400),
          lastCycleCompletedAt: minutesAgo(399)
        }
      });
    expect(auditDrift(at(minutesAgo(119))).failures).toEqual([]);
    expect(auditDrift(at(minutesAgo(121))).failures).toEqual([
      expect.objectContaining({ check: "drift_stale_pending" })
    ]);
  });

  it("measures a busy group's staleness from its earliest uncovered write, not its newest", () => {
    // Break caught: the newest write set the clock, so a group written at
    // least hourly kept real drift pending for ever.
    const audit = baseAudit({
      ...groupDriftAudit({
        writtenAt: minutesAgo(250),
        recomputedAt: minutesAgo(300),
        maintenance: { lastCycleStartedAt: null, lastCycleCompletedAt: null }
      }),
      ledger: [250, 190, 130, 70, 10].map((minutes) =>
        ledgerRow({
          runId: `r${minutes}`,
          family: "raiderio",
          runStartedAt: minutesAgo(minutes),
          writtenAt: minutesAgo(minutes)
        })
      )
    });
    expect(auditDrift(audit).failures).toEqual([
      expect.objectContaining({ check: "drift_stale_pending" })
    ]);
  });

  it("measures the manual arm from the earliest manual change no cycle covers", () => {
    const audit = (manualChanges: Date[]) =>
      baseAudit({
        graph: graphOf({
          names: ["o", "t"],
          links: [{ a: "o", b: "t", strength: "manual" }],
          groupOf: new Map([
            ["o", "g1"],
            ["t", "g2"]
          ])
        }),
        groups: new Map([
          ["g1", { recomputedAt: minutesAgo(600), members: ["o"] }],
          ["g2", { recomputedAt: minutesAgo(600), members: ["t"] }]
        ]),
        maintenance: {
          lastCycleStartedAt: minutesAgo(300),
          lastCycleCompletedAt: minutesAgo(299)
        },
        manualChanges
      });
    // The change before the cycle started is covered; the one after it,
    // 150 minutes ago, has waited past the 2 h bound.
    expect(
      auditDrift(audit([minutesAgo(400), minutesAgo(150), minutesAgo(5)]))
        .failures
    ).toEqual([expect.objectContaining({ check: "drift_stale_pending" })]);
    expect(
      auditDrift(audit([minutesAgo(400), minutesAgo(5)])).failures
    ).toEqual([]);
  });

  it("treats drift as pending when any group involved is pending, the absorbed side of a merge included", () => {
    expect(auditDrift(mergeWithPendingAbsorbedAudit()).failures).toEqual([]);
  });

  it("finds no drift when stored groups match the recomputed ones", () => {
    const audit = baseAudit({
      graph: graphOf({
        names: ["o", "a", "z"],
        links: [{ a: "o", b: "a", strength: "raiderio" }],
        groupOf: new Map([
          ["o", "g1"],
          ["a", "g1"],
          ["z", "g2"]
        ])
      }),
      groups: new Map([
        ["g1", { recomputedAt: minutesAgo(60), members: ["a", "o"] }],
        ["g2", { recomputedAt: minutesAgo(60), members: ["z"] }]
      ])
    });
    expect(auditDrift(audit)).toEqual({ failures: [], reports: [] });
  });

  it("treats an ungrouped character as pending until a cycle that started after its creation completes", () => {
    const pending = baseAudit({
      graph: graphOf({ names: ["x"], groupOf: new Map() }),
      ungroupedSince: new Map([["x", minutesAgo(5)]]),
      maintenance: {
        lastCycleStartedAt: minutesAgo(30),
        lastCycleCompletedAt: minutesAgo(29)
      }
    });
    expect(auditDrift(pending)).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    const stale = baseAudit({
      graph: graphOf({ names: ["x"], groupOf: new Map() }),
      ungroupedSince: new Map([["x", minutesAgo(60)]]),
      maintenance: {
        lastCycleStartedAt: minutesAgo(30),
        lastCycleCompletedAt: minutesAgo(29)
      }
    });
    expect(auditDrift(stale).failures).toEqual([
      expect.objectContaining({ check: "drift" })
    ]);
  });

  it("treats a merge across a manual link as pending while a manual change is newer than the last cycle", () => {
    const merge = (manualChangedAt: Date) =>
      baseAudit({
        graph: graphOf({
          names: ["o", "t"],
          links: [{ a: "o", b: "t", strength: "manual" }],
          groupOf: new Map([
            ["o", "g1"],
            ["t", "g2"]
          ])
        }),
        groups: new Map([
          ["g1", { recomputedAt: minutesAgo(60), members: ["o"] }],
          ["g2", { recomputedAt: minutesAgo(60), members: ["t"] }]
        ]),
        maintenance: {
          lastCycleStartedAt: minutesAgo(30),
          lastCycleCompletedAt: minutesAgo(29)
        },
        manualChanges: [manualChangedAt]
      });
    expect(auditDrift(merge(minutesAgo(5)))).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(auditDrift(merge(minutesAgo(45))).failures).toEqual([
      expect.objectContaining({ check: "drift" })
    ]);
  });

  it("reports a group's pending drift for under two hours after its write, and fails it after, with no cycle ever completed", () => {
    const at = (writtenAt: Date) =>
      groupDriftAudit({
        writtenAt,
        recomputedAt: minutesAgo(180),
        maintenance: { lastCycleStartedAt: null, lastCycleCompletedAt: null }
      });
    expect(auditDrift(at(minutesAgo(119)))).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(auditDrift(at(minutesAgo(121)))).toMatchObject({
      failures: [expect.objectContaining({ check: "drift_stale_pending" })],
      reports: []
    });
  });

  it("bounds an ungrouped character's pending drift at two hours after its creation, under a stale cycle", () => {
    const at = (createdAt: Date) =>
      baseAudit({
        graph: graphOf({ names: ["x"], groupOf: new Map() }),
        ungroupedSince: new Map([["x", createdAt]]),
        maintenance: {
          lastCycleStartedAt: minutesAgo(180),
          lastCycleCompletedAt: minutesAgo(179)
        }
      });
    expect(auditDrift(at(minutesAgo(119)))).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(auditDrift(at(minutesAgo(121))).failures).toEqual([
      expect.objectContaining({ check: "drift_stale_pending" })
    ]);
  });

  it("bounds pending drift from a manual change at two hours after the change", () => {
    const at = (manualChangedAt: Date) =>
      baseAudit({
        graph: graphOf({
          names: ["o", "t"],
          links: [{ a: "o", b: "t", strength: "manual" }],
          groupOf: new Map([
            ["o", "g1"],
            ["t", "g2"]
          ])
        }),
        groups: new Map([
          ["g1", { recomputedAt: minutesAgo(300), members: ["o"] }],
          ["g2", { recomputedAt: minutesAgo(300), members: ["t"] }]
        ]),
        manualChanges: [manualChangedAt]
      });
    expect(auditDrift(at(minutesAgo(119)))).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(auditDrift(at(minutesAgo(121))).failures).toEqual([
      expect.objectContaining({ check: "drift_stale_pending" })
    ]);
  });

  it("treats a write up to 5 s before its group's recompute as pending, and one 5 s before or earlier as settled", () => {
    // Neither `written_at` nor `recomputed_at` is a commit time, so a
    // recompute that started just after a write's ledger insert may not have
    // seen it.
    const recomputedAt = minutesAgo(60);
    const at = (msBefore: number) =>
      groupDriftAudit({
        writtenAt: new Date(recomputedAt.getTime() - msBefore),
        recomputedAt,
        maintenance: { lastCycleStartedAt: null, lastCycleCompletedAt: null }
      });
    expect(auditDrift(at(4_999))).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(auditDrift(at(5_000)).failures).toEqual([
      expect.objectContaining({ check: "drift" })
    ]);
  });

  it("only counts a cycle that started at least 5 s after the write as covering it", () => {
    const writtenAt = minutesAgo(60);
    const at = (msAfter: number) =>
      groupDriftAudit({
        writtenAt,
        recomputedAt: minutesAgo(90),
        maintenance: {
          lastCycleStartedAt: new Date(writtenAt.getTime() + msAfter),
          lastCycleCompletedAt: minutesAgo(30)
        }
      });
    expect(auditDrift(at(4_999))).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(auditDrift(at(5_000)).failures).toEqual([
      expect.objectContaining({ check: "drift" })
    ]);
  });
});

describe("page comparison", () => {
  it("matches alias identities as sets, whichever key each side makes primary", () => {
    // One Warcraft Logs identity with a manual-excluded key (a1) and a
    // discovered-excluded key (a2). Today's read lists manual exclusions
    // last, so it leads with a2; the group read leads with a1, which sorts
    // first. Matching by primary would call a2 removed and its Raider.IO
    // label weakened to a1's manual one.
    const graph = graphOf({
      names: ["o", "a1", "a2"],
      links: [
        { a: "o", b: "a1", strength: "manual" },
        { a: "o", b: "a2", strength: "raiderio" }
      ],
      manual: [{ makerId: "o", targetId: "a1", excluded: true }],
      discoveredExclusions: [{ makerId: "o", targetId: "a2" }],
      warcraftLogsIds: new Map([
        ["a1", 7],
        ["a2", 7]
      ])
    });
    const legacy = legacyPages([
      page("o", [
        row("o", "input"),
        row("a2", "claimed", { aliases: ["a1"], excluded: true })
      ])
    ]);
    const result = comparePages(
      baseAudit({ graph, roots: [key("o")] }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({ pages: 1, unchanged: 1 });
  });

  it("fails a removed character and a weakened label", () => {
    const graph = graphOf({
      names: ["o", "a", "f"],
      links: [{ a: "o", b: "a", strength: "fingerprint" }]
    });
    const legacy = legacyPages([
      page("o", [
        row("o", "input"),
        row("a", "claimed"),
        row("f", "fingerprint")
      ])
    ]);
    const result = comparePages(
      baseAudit({ graph, roots: [key("o")] }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([
      { check: "removed", detail: "eu/draenor/f from eu/draenor/o" },
      { check: "label_weakened", detail: "eu/draenor/a on eu/draenor/o" }
    ]);
  });

  it("does not weaken a label that only changed within Raider.IO sources", () => {
    const graph = graphOf({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }]
    });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("a", "profile_guess")])
    ]);
    expect(
      comparePages(baseAudit({ graph, roots: [key("o")] }), legacy, CONFIG)
        .failures
    ).toEqual([]);
  });

  it("compares pages over groups recomputed from the links, not the stored groups", () => {
    const graph = graphOf({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      groupOf: new Map([
        ["o", "g1"],
        ["a", "g2"]
      ])
    });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("a", "claimed")])
    ]);
    expect(
      comparePages(baseAudit({ graph, roots: [key("o")] }), legacy, CONFIG)
        .failures
    ).toEqual([]);
  });

  it("reports growth, and counts an identical page as unchanged", () => {
    const graph = graphOf({
      names: ["o", "a", "p"],
      links: [
        { a: "o", b: "a", strength: "raiderio" },
        { a: "p", b: "o", strength: "raiderio" }
      ]
    });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("a", "claimed"), row("p", "claimed")]),
      page("p", [row("p", "input"), row("o", "claimed")])
    ]);
    const result = comparePages(
      baseAudit({ graph, roots: [key("o"), key("p")] }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([]);
    expect(result.reports).toEqual([
      { check: "grew", detail: "1 more on eu/draenor/p" }
    ]);
    expect(result.counts).toMatchObject({ pages: 2, unchanged: 1, grew: 1 });
  });

  it("reports a shared exclusion from another member, not a failure", () => {
    const graph = graphOf({
      names: ["o", "p", "x"],
      links: [
        { a: "o", b: "p", strength: "raiderio" },
        { a: "o", b: "x", strength: "raiderio" },
        { a: "p", b: "x", strength: "raiderio" }
      ],
      discoveredExclusions: [{ makerId: "p", targetId: "x" }]
    });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("p", "claimed"), row("x", "claimed")])
    ]);
    const result = comparePages(
      baseAudit({ graph, roots: [key("o")] }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([]);
    expect(result.reports).toEqual([
      { check: "shared_exclusion", detail: "eu/draenor/x on eu/draenor/o" }
    ]);
    expect(result.counts.sharedExclusions).toBe(1);
  });

  it("fails an exclusion no row in the group explains", () => {
    const graph = graphOf({
      names: ["o", "x"],
      links: [{ a: "o", b: "x", strength: "raiderio" }]
    });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("x", "claimed", { excluded: true })])
    ]);
    // The real resolver only excludes through rows, so a resolver that
    // greys `x` without one stands in for a regression.
    const resolve = (): GroupSubjects => ({
      selected: [subject("o", "input")],
      skipped: [],
      excluded: [subject("x", "claimed")],
      research: { state: "complete", limitationCodes: [] }
    });
    expect(
      comparePages(
        baseAudit({ graph, roots: [key("o")] }),
        legacy,
        CONFIG,
        resolve
      ).failures
    ).toEqual([
      { check: "exclusion_unexplained", detail: "eu/draenor/x on eu/draenor/o" }
    ]);
  });

  it("fails an exclusion today's page applies that the group page drops", () => {
    const graph = graphOf({
      names: ["o", "x"],
      links: [{ a: "o", b: "x", strength: "raiderio" }]
    });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("x", "claimed", { excluded: true })])
    ]);
    expect(
      comparePages(baseAudit({ graph, roots: [key("o")] }), legacy, CONFIG)
        .failures
    ).toEqual([
      { check: "exclusion_lost", detail: "eu/draenor/x on eu/draenor/o" }
    ]);
  });

  it("counts self-exclusions separately and ignores them", () => {
    const graph = graphOf({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      discoveredExclusions: [
        { makerId: "o", targetId: "o" },
        { makerId: "a", targetId: "a" }
      ]
    });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("a", "claimed")])
    ]);
    const result = comparePages(
      baseAudit({ graph, roots: [key("o")] }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([]);
    expect(result.counts.selfExclusions).toBe(2);
  });

  it("fails a missing limitation code unless a shared exclusion explains it", () => {
    const graph = graphOf({
      names: ["o", "p", "x"],
      links: [
        { a: "o", b: "p", strength: "raiderio" },
        { a: "o", b: "x", strength: "raiderio" }
      ],
      latestSnapshot: new Map([
        ["o", { state: "complete", limitationCode: null }]
      ])
    });
    const limited = page(
      "o",
      [row("o", "input"), row("p", "claimed"), row("x", "claimed")],
      { state: "partial", limitationCode: "privacy_hidden" }
    );
    const missing = comparePages(
      baseAudit({ graph, roots: [key("o")] }),
      legacyPages([limited]),
      CONFIG
    );
    expect(missing.failures).toEqual([
      { check: "limitation_missing", detail: "privacy_hidden on eu/draenor/o" }
    ]);
    const explained = comparePages(
      baseAudit({
        graph: {
          ...graph,
          discoveredExclusions: [{ makerId: "p", targetId: "x" }]
        },
        roots: [key("o")]
      }),
      legacyPages([limited]),
      CONFIG
    );
    expect(explained.failures).toEqual([]);
    expect(explained.reports).toContainEqual({
      check: "limitation_removed",
      detail: "privacy_hidden on eu/draenor/o"
    });
  });

  it("reports a research state change", () => {
    const graph = graphOf({ names: ["o"], latestSnapshot: new Map() });
    const legacy = legacyPages([page("o", [row("o", "input")])]);
    expect(
      comparePages(baseAudit({ graph, roots: [key("o")] }), legacy, CONFIG)
        .reports
    ).toEqual([
      {
        check: "research_state_changed",
        detail: "complete to partial on eu/draenor/o"
      }
    ]);
  });

  it("does not report a research state change for a borrowed, provisional page", () => {
    // Today's state for a provisional page is the borrowed snapshot's, not
    // the page's assembled state, so every one would show as changed.
    const graph = graphOf({ names: ["o"], latestSnapshot: new Map() });
    const [id, borrowed] = page("o", [row("o", "input")]);
    const result = comparePages(
      baseAudit({ graph, roots: [key("o")] }),
      legacyPages([[id, { ...borrowed, provisional: true }]]),
      CONFIG
    );
    expect(result.reports).toEqual([]);
    expect(result.counts).toMatchObject({
      provisional: 1,
      researchStateChanged: 0
    });
  });

  it("fails a page over the ceiling", () => {
    const graph = graphOf({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }]
    });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("a", "claimed")])
    ]);
    expect(
      comparePages(baseAudit({ graph, roots: [key("o")] }), legacy, {
        DOSSIER_CHARACTER_CEILING: 1
      }).failures
    ).toContainEqual({ check: "over_ceiling", detail: "eu/draenor/o" });
  });

  it("fails an undiscovered manual target today's page shows and the group page drops", () => {
    // Break caught: a manual target with no character row was reported as
    // pending rather than failed, so the group read could drop it for good.
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("undiscovered", "manually_added")])
    ]);
    const kept = comparePages(
      baseAudit({
        graph: graphOf({
          names: ["o"],
          undiscoveredManualTargets: [
            { makerId: "o", targetKey: key("undiscovered"), excluded: false }
          ]
        }),
        roots: [key("o")]
      }),
      legacy,
      CONFIG
    );
    expect(kept.failures).toEqual([]);
    expect(kept.reports).toEqual([]);
    expect(kept.counts).toMatchObject({ pages: 1, unchanged: 1 });
    const dropped = comparePages(
      baseAudit({ graph: graphOf({ names: ["o"] }), roots: [key("o")] }),
      legacy,
      CONFIG
    );
    expect(dropped.failures).toEqual([
      {
        check: "removed",
        detail: "eu/draenor/undiscovered from eu/draenor/o"
      }
    ]);
  });

  it("explains an undiscovered manual target's exclusion by its manual row", () => {
    const legacy = legacyPages([
      page("o", [
        row("o", "input"),
        row("undiscovered", "manually_added", { excluded: true })
      ])
    ]);
    const result = comparePages(
      baseAudit({
        graph: graphOf({
          names: ["o"],
          undiscoveredManualTargets: [
            { makerId: "o", targetKey: key("undiscovered"), excluded: true }
          ]
        }),
        roots: [key("o")]
      }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([]);
    expect(result.reports).toEqual([]);
  });

  it("skips a page whose characters published under 10 minutes ago", () => {
    const graph = graphOf({ names: ["o"] });
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("new", "claimed")])
    ]);
    const result = comparePages(
      baseAudit({
        graph,
        roots: [key("o")],
        publications: [
          { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(1) }
        ]
      }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({ pages: 0, pendingPages: 1 });
  });

  it("skips a page whose snapshot moved after the audit's read, as page_moved", () => {
    // Break caught: the script resolves today's pages after the audit's
    // consistent read, so a publication in between showed its new members
    // (or its dropped ones) against the audit's older groups, and failed as
    // `removed`.
    const graph = graphOf({
      names: ["o", "a", "p"],
      links: [{ a: "o", b: "a", strength: "raiderio" }]
    });
    const [id, moved] = page("o", [row("o", "input"), row("p", "claimed")]);
    const legacy = legacyPages([
      [id, { ...moved, snapshot: { ...moved.snapshot, id: "snapshot-newer" } }]
    ]);
    const result = comparePages(
      baseAudit({ graph, roots: [key("o")] }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([]);
    expect(result.reports).toEqual([
      { check: "page_moved", detail: "eu/draenor/o" }
    ]);
    expect(result.counts).toMatchObject({ pages: 0, movedPages: 1 });

    // The same page from the audit's own snapshot is compared, and fails.
    expect(
      comparePages(
        baseAudit({ graph, roots: [key("o")] }),
        legacyPages([page("o", [row("o", "input"), row("p", "claimed")])]),
        CONFIG
      ).failures
    ).toEqual([{ check: "removed", detail: "eu/draenor/p from eu/draenor/o" }]);
  });

  it("never prints a suppressed character's key", () => {
    const graph = graphOf({
      names: ["o", "hidden"],
      links: [{ a: "o", b: "hidden", strength: "raiderio" }],
      suppressed: new Set(["hidden"])
    });
    // A legacy read taken before the suppression still lists the character.
    const legacy = legacyPages([
      page("o", [row("o", "input"), row("hidden", "claimed")])
    ]);
    const result = comparePages(
      baseAudit({ graph, roots: [key("o")] }),
      legacy,
      CONFIG
    );
    expect(result.failures).toEqual([
      { check: "removed", detail: "(suppressed) from eu/draenor/o" }
    ]);
  });
});

describe("replay", () => {
  it("fails on every check and reports without failing", () => {
    const audit = baseAudit({
      ...manualOnlyDriftAudit(),
      publications: [
        { kind: "run", runId: "lost", observerId: "o", at: minutesAgo(60) }
      ]
    });
    const report = replayCharacterGroups(audit, new Map(), CONFIG);
    expect(report.failures.map((finding) => finding.check)).toEqual([
      "a_completeness"
    ]);
    expect(report.reports.map((finding) => finding.check)).toEqual([
      "drift_manual"
    ]);
  });

  it("reports its window, the publications it checked and the last cycle", () => {
    // Break caught: a rebuild just before a replay left (a) to (d) nearly
    // empty, and nothing in the output showed it.
    const audit = baseAudit({
      ledger: [
        backfill("o", "raiderio", minutesAgo(600)),
        ledgerRow({ runId: "r1", family: "raiderio" })
      ],
      publications: [
        { kind: "run", runId: "before", observerId: "o", at: minutesAgo(700) },
        { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(60) },
        { kind: "run", runId: "young", observerId: "o", at: minutesAgo(1) }
      ],
      maintenance: {
        lastCycleStartedAt: minutesAgo(30),
        lastCycleCompletedAt: minutesAgo(29)
      }
    });
    const report = replayCharacterGroups(audit, new Map(), CONFIG);
    expect(report).toMatchObject({
      failures: [],
      windowStart: minutesAgo(600).toISOString(),
      publicationsChecked: 1,
      lastCycleStartedAt: minutesAgo(30).toISOString(),
      lastCycleCompletedAt: minutesAgo(29).toISOString()
    });
    expect(replayCharacterGroups(baseAudit(), new Map(), CONFIG)).toMatchObject(
      {
        windowStart: null,
        lastCycleStartedAt: null,
        lastCycleCompletedAt: null
      }
    );
  });

  it("fails maintenance_stale when no cycle has completed within the bound", () => {
    // Break caught: with no completed cycle, drift was never judged and the
    // replay passed.
    const audit = (
      windowStartedAt: Date,
      maintenance: CharacterGroupsAudit["maintenance"]
    ) =>
      baseAudit({
        ledger: [backfill("o", "raiderio", windowStartedAt)],
        maintenance
      });
    const checks = (value: CharacterGroupsAudit) =>
      replayCharacterGroups(value, new Map(), CONFIG).failures.map(
        (finding) => finding.check
      );
    const never = { lastCycleStartedAt: null, lastCycleCompletedAt: null };
    expect(checks(audit(minutesAgo(119), never))).toEqual([]);
    expect(checks(audit(minutesAgo(121), never))).toEqual([
      "maintenance_stale"
    ]);
    // A cycle completed long ago, and the window started just now: measured
    // from the window start.
    const old = {
      lastCycleStartedAt: minutesAgo(1_000),
      lastCycleCompletedAt: minutesAgo(999)
    };
    expect(checks(audit(minutesAgo(10), old))).toEqual([]);
    expect(checks(audit(minutesAgo(900), old))).toEqual(["maintenance_stale"]);
    // A long last cycle stretches the bound: 1 h + 2 × 100 min.
    const long = {
      lastCycleStartedAt: minutesAgo(350),
      lastCycleCompletedAt: minutesAgo(250)
    };
    expect(checks(audit(minutesAgo(900), long))).toEqual([]);
    const longer = {
      lastCycleStartedAt: minutesAgo(370),
      lastCycleCompletedAt: minutesAgo(270)
    };
    expect(checks(audit(minutesAgo(900), longer))).toEqual([
      "maintenance_stale"
    ]);
  });

  it("measures maintenance from the first ledger write when there is no baseline row", () => {
    const audit = (writtenAt: Date) =>
      baseAudit({
        ledger: [ledgerRow({ runId: "r1", family: "raiderio", writtenAt })]
      });
    const checks = (value: CharacterGroupsAudit) =>
      replayCharacterGroups(value, new Map(), CONFIG).failures.map(
        (finding) => finding.check
      );
    expect(checks(audit(minutesAgo(30)))).toEqual([]);
    expect(checks(audit(minutesAgo(130)))).toEqual(["maintenance_stale"]);
  });
});

const NOW = new Date("2026-10-01T12:00:00Z");

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function key(name: string): CharacterKey {
  return { region: "eu", realm: "draenor", name };
}

function graphOf(
  overrides: Partial<Omit<GroupGraph, "characters" | "idOf">> & {
    names?: string[];
  }
): GroupGraph {
  const names = overrides.names ?? [];
  const characters = new Map(
    names.map((name) => [
      name,
      {
        key: key(name),
        displayName: name,
        className: "Mage",
        level: 80,
        raiderIoUrl: `https://raider.io/characters/eu/draenor/${name}`
      }
    ])
  );
  const warcraftLogsIds = overrides.warcraftLogsIds ?? new Map();
  return {
    characters,
    idOf: (candidate) =>
      candidate.region === "eu" &&
      candidate.realm === "draenor" &&
      characters.has(candidate.name)
        ? candidate.name
        : undefined,
    groupOf: overrides.groupOf ?? new Map(names.map((name) => [name, "g"])),
    links: overrides.links ?? [],
    manual: overrides.manual ?? [],
    undiscoveredManualTargets: overrides.undiscoveredManualTargets ?? [],
    discoveredExclusions: overrides.discoveredExclusions ?? [],
    suppressed: overrides.suppressed ?? new Set(),
    warcraftLogsIds,
    sharedIdentity:
      overrides.sharedIdentity ??
      ((id) => {
        const wcl = warcraftLogsIds.get(id);
        return new Set([
          id,
          ...[...warcraftLogsIds]
            .filter(([, other]) => wcl !== undefined && other === wcl)
            .map(([other]) => other)
        ]);
      }),
    // Every character has a complete snapshot of its own unless a test says
    // otherwise, so research state only changes where a test means it to.
    latestSnapshot:
      overrides.latestSnapshot ??
      new Map(
        names.map((name) => [
          name,
          { state: "complete" as const, limitationCode: null }
        ])
      )
  };
}

function baseAudit(
  overrides: Partial<CharacterGroupsAudit> = {}
): CharacterGroupsAudit {
  const audit = {
    now: NOW,
    graph: graphOf({}),
    groups: new Map(),
    maintenance: { lastCycleStartedAt: null, lastCycleCompletedAt: null },
    observations: [],
    ledger: [],
    publications: [],
    latestRawMembership: new Map(),
    manualChanges: [],
    observedEver: new Map(),
    manualCreatedAt: [],
    roots: [],
    ungroupedSince: new Map(),
    ...overrides
  };
  // By default each root's page was resolved from the snapshot the audit
  // read, the id `page` gives it.
  return {
    ...audit,
    latestSnapshotIds:
      overrides.latestSnapshotIds ??
      new Set(audit.roots.map((root) => `snapshot-${root.name}`))
  };
}

function ledgerRow(
  overrides: Partial<CharacterGroupsLedgerRow> &
    Pick<CharacterGroupsLedgerRow, "runId" | "family">
): CharacterGroupsLedgerRow {
  return {
    sweepReservationId: null,
    observerId: "o",
    decision: "added_only",
    reason: overrides.family === "fingerprint" ? "capped" : "raiderio_limited",
    runStartedAt: minutesAgo(40),
    writtenAt: minutesAgo(30),
    ...overrides
  };
}

function backfill(
  observerId: string,
  family: "raiderio" | "fingerprint",
  writtenAt: Date
): CharacterGroupsLedgerRow {
  return ledgerRow({
    runId: `backfill-${observerId}-${family}`,
    observerId,
    family,
    decision: "replaced",
    reason: "backfill",
    runStartedAt: writtenAt,
    writtenAt
  });
}

/**
 * A published sweep reservation of o's. By default its cycle was capped,
 * which is what the handler stores on a cycle that did not seal.
 */
function reservation(
  reservationId: string,
  runId: string,
  at: Date,
  limitationCode: string | null = "fingerprint_sweep_capped"
): CharacterGroupsPublication {
  return {
    kind: "reservation",
    reservationId,
    runId,
    observerId: "o",
    at,
    limitationCode
  };
}

/**
 * An observation `observerId` made of `otherId`. By default it was made a
 * day ago, before any run these tests replace with.
 */
function observationRow(
  observerId: string,
  otherId: string,
  source: string,
  runId: string,
  observedAt: Date = minutesAgo(24 * 60)
): CharacterGroupsObservation {
  const [lowId, highId] =
    observerId < otherId ? [observerId, otherId] : [otherId, observerId];
  return { lowId, highId, source, observerId, runId, observedAt };
}

/** Stored `{o}` alone, a link o–a, and o's write after the recompute. */
function pendingDriftAudit(options: {
  cycleStartedAfterWrite: boolean;
}): CharacterGroupsAudit {
  return baseAudit({
    graph: graphOf({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      groupOf: new Map([
        ["o", "g1"],
        ["a", "g2"]
      ])
    }),
    groups: new Map([
      ["g1", { recomputedAt: minutesAgo(60), members: ["o"] }],
      ["g2", { recomputedAt: minutesAgo(60), members: ["a"] }]
    ]),
    ledger: [
      ledgerRow({ runId: "r1", family: "raiderio", writtenAt: minutesAgo(30) })
    ],
    maintenance: options.cycleStartedAfterWrite
      ? {
          lastCycleStartedAt: minutesAgo(20),
          lastCycleCompletedAt: minutesAgo(19)
        }
      : {
          lastCycleStartedAt: minutesAgo(90),
          lastCycleCompletedAt: minutesAgo(89)
        }
  });
}

/**
 * Stored `{o}` and `{a}`, a link o–a, and one write by o: the drift is
 * pending or not by the write's time against the recompute and the cycle.
 */
function groupDriftAudit(options: {
  writtenAt: Date;
  recomputedAt: Date;
  maintenance: CharacterGroupsAudit["maintenance"];
}): CharacterGroupsAudit {
  return baseAudit({
    graph: graphOf({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      groupOf: new Map([
        ["o", "g1"],
        ["a", "g2"]
      ])
    }),
    groups: new Map([
      ["g1", { recomputedAt: options.recomputedAt, members: ["o"] }],
      ["g2", { recomputedAt: options.recomputedAt, members: ["a"] }]
    ]),
    ledger: [
      ledgerRow({
        runId: "r1",
        family: "raiderio",
        runStartedAt: options.writtenAt,
        writtenAt: options.writtenAt
      })
    ],
    maintenance: options.maintenance
  });
}

/**
 * Stored `{o, t}`, joined only by a manual row since deleted: the links
 * recompute to `{o}` and `{t}`, which share no observed link.
 */
function manualOnlyDriftAudit(): CharacterGroupsAudit {
  return baseAudit({
    graph: graphOf({
      names: ["o", "t"],
      groupOf: new Map([
        ["o", "g"],
        ["t", "g"]
      ])
    }),
    groups: new Map([
      ["g", { recomputedAt: minutesAgo(60), members: ["o", "t"] }]
    ]),
    maintenance: {
      lastCycleStartedAt: minutesAgo(30),
      lastCycleCompletedAt: minutesAgo(29)
    }
  });
}

/**
 * Two stored groups a link now joins. The absorbing side, `a`, is settled;
 * only the absorbed side, `z`, has a write newer than its recompute.
 */
function mergeWithPendingAbsorbedAudit(): CharacterGroupsAudit {
  return baseAudit({
    graph: graphOf({
      names: ["a", "z"],
      links: [{ a: "a", b: "z", strength: "raiderio" }],
      groupOf: new Map([
        ["a", "g1"],
        ["z", "g2"]
      ])
    }),
    groups: new Map([
      ["g1", { recomputedAt: minutesAgo(10), members: ["a"] }],
      ["g2", { recomputedAt: minutesAgo(60), members: ["z"] }]
    ]),
    ledger: [
      ledgerRow({
        runId: "r0",
        family: "raiderio",
        observerId: "a",
        writtenAt: minutesAgo(90)
      }),
      ledgerRow({
        runId: "r1",
        family: "raiderio",
        observerId: "z",
        writtenAt: minutesAgo(30)
      })
    ]
  });
}

function subject(
  name: string,
  source: RankedSubject["source"],
  aliases: string[] = []
): RankedSubject {
  return {
    key: key(name),
    displayName: name,
    className: "Mage",
    guild: null,
    raiderIoUrl: `https://raider.io/characters/eu/draenor/${name}`,
    level: 80,
    source,
    ...(aliases.length > 0 ? { warcraftLogsAliases: aliases.map(key) } : {})
  };
}

function row(
  name: string,
  source: RankedSubject["source"],
  options: { aliases?: string[]; excluded?: boolean } = {}
) {
  return {
    subject: subject(name, source, options.aliases),
    excluded: options.excluded ?? false
  };
}

function page(
  rootName: string,
  rows: ReturnType<typeof row>[],
  snapshot: { state: "complete" | "partial"; limitationCode: string | null } = {
    state: "complete",
    limitationCode: null
  }
): [string, ResolvedSubjects] {
  const stored: StoredSnapshot = {
    id: `snapshot-${rootName}`,
    runId: `run-${rootName}`,
    rootKey: key(rootName),
    state: snapshot.state,
    limitationCode: snapshot.limitationCode,
    refreshedAt: minutesAgo(120),
    characterCount: rows.length,
    characters: []
  };
  return [
    canonicalCharacterId(key(rootName)),
    {
      snapshot: stored,
      selected: rows.filter((r) => !r.excluded).map((r) => r.subject),
      skipped: [],
      excludedOrdered: rows.filter((r) => r.excluded).map((r) => r.subject),
      provisional: false
    }
  ];
}

function legacyPages(
  pages: [string, ResolvedSubjects][]
): Map<string, ResolvedSubjects | null> {
  return new Map(pages);
}
