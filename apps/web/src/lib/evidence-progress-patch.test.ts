import { describe, expect, it } from "vitest";
import {
  applicantDossierSchema,
  type ApplicantDossier,
  type EvidenceRunProgressResponse
} from "@slashwho/contracts";
import { patchEvidenceProgress } from "./evidence-progress-patch";

const key = { region: "eu", realm: "silvermoon", name: "subject" } as const;
const alias = { ...key, name: "alias" };
const otherAlias = { ...key, name: "older" };
const phase = { id: "publication", state: "pending" } as const;
function dossier(): ApplicantDossier {
  return {
    root: key,
    research: { state: "complete", message: "Complete" },
    characters: [
      {
        key,
        displayName: "Subject",
        className: null,
        source: "raiderio_declared",
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/subject",
        evidenceState: "waiting",
        collectionProgress: [phase]
      }
    ],
    raids: [],
    cuttingEdges: [],
    limitations: []
  };
}
function run(
  key: EvidenceRunProgressResponse["runs"][number]["key"],
  state: "running" | "queued" | "settled" = "running",
  collectionProgress: EvidenceRunProgressResponse["runs"][number]["collectionProgress"] = [
    { ...phase, state: "active" }
  ]
): EvidenceRunProgressResponse["runs"][number] {
  return {
    id: "10000000-0000-4000-8000-000000000013",
    key,
    state,
    collectionProgress,
    evidenceState:
      state === "running"
        ? "scanning"
        : state === "queued"
          ? "waiting"
          : "complete",
    version: state
  };
}
describe("patchEvidenceProgress", () => {
  it("preserves unavailable and not-applicable parse metrics without inventing zeros", () => {
    const before = dossier();
    before.raids = [
      {
        raidId: "raid",
        raidName: "Raid",
        imageUrl: null,
        cuttingEdge: null,
        bosses: [
          {
            bossId: "boss",
            bossName: "Boss",
            bossOrder: 1,
            imageUrl: null,
            state: "kill",
            firstKill: {
              killedAt: "2026-10-13T12:00:00.000Z",
              guild: null,
              historicWorldRank: null,
              reportUrl: null,
              characters: [key],
              parses: [
                {
                  character: "Subject",
                  damage: { state: "unavailable" },
                  healing: { state: "not_applicable" },
                  bossDamage: { state: "unavailable" }
                }
              ]
            },
            bestParses: []
          }
        ]
      }
    ];
    const after = patchEvidenceProgress(before, [run(key)]);
    expect(after.raids).toBe(before.raids);
    const boss = after.raids[0]!.bosses[0]!;
    if (boss.state !== "kill") throw new Error("kill_missing");
    expect(boss.firstKill.parses[0]).toEqual({
      character: "Subject",
      damage: { state: "unavailable" },
      healing: { state: "not_applicable" },
      bossDamage: { state: "unavailable" }
    });
    expect(applicantDossierSchema.safeParse(after).success).toBe(true);
  });
  it("updates only a live row and keeps published evidence by reference", () => {
    const before = dossier();
    const after = patchEvidenceProgress(before, [run(key)]);
    expect(after.characters[0]).toMatchObject({
      evidenceState: "scanning",
      researchState: "gathering",
      collectionProgress: [{ id: "publication", state: "active" }]
    });
    expect(after.raids).toBe(before.raids);
    expect(after.limitations).toBe(before.limitations);
    expect(applicantDossierSchema.safeParse(after).success).toBe(true);
    expect(patchEvidenceProgress(after, [run(key)])).toBe(after);
  });
  it("maps an alias-only collection to its subject", () => {
    const before = dossier();
    before.characters[0]!.warcraftLogsAliases = [alias];
    expect(
      patchEvidenceProgress(before, [run(alias)]).characters[0]
    ).toMatchObject({
      evidenceState: "scanning",
      researchState: "gathering",
      collectionProgress: [{ id: "publication", state: "active" }]
    });
  });
  it("selects the subject before aliases and aliases in identity order", () => {
    const before = dossier();
    before.characters[0]!.warcraftLogsAliases = [alias, otherAlias];
    const subjectRun = run(key, "running", [
      { id: "warcraft_logs_history", state: "active" }
    ]);
    const aliasRun = run(alias, "running", [
      { id: "publication", state: "limited", limitationCode: "rate_limited" }
    ]);
    const olderRun = run(otherAlias);
    expect(
      patchEvidenceProgress(before, [olderRun, aliasRun, subjectRun])
        .characters[0]!.collectionProgress
    ).toEqual([{ id: "warcraft_logs_history", state: "active" }]);
    expect(
      patchEvidenceProgress(before, [olderRun, aliasRun, run(key, "settled")])
        .characters[0]!.collectionProgress
    ).toEqual([
      { id: "publication", state: "limited", limitationCode: "rate_limited" }
    ]);
  });
  it("preserves a multi-identity state while any identity is queued or unknown", () => {
    const before = dossier();
    before.characters[0]!.warcraftLogsAliases = [alias];
    expect(
      patchEvidenceProgress(before, [run(key), run(alias, "queued")])
        .characters[0]!.evidenceState
    ).toBe("waiting");
    expect(
      patchEvidenceProgress(before, [run(key)], true).characters[0]!
        .evidenceState
    ).toBe("waiting");
    expect(
      patchEvidenceProgress(before, [run(key), run(alias)]).characters[0]!
        .evidenceState
    ).toBe("scanning");
  });
  it.each(["complete", "partial", "scanning"] as const)(
    "preserves published or uncertain %s states",
    (state) => {
      const before = dossier();
      before.characters[0]!.evidenceState = state;
      before.characters[0]!.warcraftLogsAliases = [alias];
      expect(
        patchEvidenceProgress(before, [run(key), run(alias, "queued")])
          .characters[0]!.evidenceState
      ).toBe(state);
    }
  );
  it.each([true, false])(
    "preserves empty progress with an existing list: %s",
    (present) => {
      const before = dossier();
      if (!present) delete before.characters[0]!.collectionProgress;
      const after = patchEvidenceProgress(before, [run(key, "running", [])]);
      expect(after.characters[0]!.collectionProgress).toEqual(
        present ? [phase] : undefined
      );
      expect(after.characters[0]!.researchState).toBe("gathering");
      expect(applicantDossierSchema.safeParse(after).success).toBe(true);
    }
  );
  it("does not patch excluded, unknown or settled rows", () => {
    const before = dossier();
    expect(patchEvidenceProgress(before, [run(alias)])).toBe(before);
    expect(patchEvidenceProgress(before, [run(key, "settled")])).toBe(before);
    before.characters[0]!.excluded = true;
    expect(patchEvidenceProgress(before, [run(key)])).toBe(before);
  });
});
