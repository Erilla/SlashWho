import { describe, expect, it } from "vitest";
import type {
  CharacterGroupsAudit,
  CharacterGroupsLedgerRow,
  CharacterGroupsObservation,
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
          at: minutesAgo(60)
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
          at: minutesAgo(60)
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

  it("counts sweep publications by cycle: first, continuation and seal", () => {
    const audit = baseAudit({
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
        manualChangedAt
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
        manualChangedAt
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
  return {
    now: NOW,
    graph: graphOf({}),
    groups: new Map(),
    maintenance: { lastCycleStartedAt: null, lastCycleCompletedAt: null },
    observations: [],
    ledger: [],
    publications: [],
    latestRawMembership: new Map(),
    manualChangedAt: null,
    manualCreatedAt: [],
    roots: [],
    ungroupedSince: new Map(),
    ...overrides
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
