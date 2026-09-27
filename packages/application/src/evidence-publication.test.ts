import { describe, expect, it } from "vitest";

import {
  fromStagedCollection,
  toStagedCollection,
  type EvidencePublication
} from "./evidence-publication";

const publication: EvidencePublication = {
  state: "partial",
  limitationCode: "request_cap",
  parseLimitationCode: null,
  parseLimitationCodesSeen: [],
  kills: [],
  wipes: [],
  tierBests: [],
  cuttingEdges: [],
  parsedFightUrls: [],
  completedAt: new Date("2026-09-27T12:00:00.000Z")
};

describe("toStagedCollection", () => {
  // Storage reads presence to decide whether a run moves a cursor, and the
  // stage crosses a JSON boundary that drops undefined keys. A key carried
  // as present-but-undefined would therefore clear the cursor on a direct
  // publish and preserve it on a republished stage.
  it("stages nothing that a JSON round trip would drop", () => {
    const staged = toStagedCollection(
      {
        ...publication,
        historyScanResumePage: undefined,
        historyScanResumeBoundaryReportCode: undefined,
        historicAliasProgress: undefined,
        rankedBackfillCursor: undefined
      } as unknown as EvidencePublication,
      undefined
    );

    expect(JSON.parse(JSON.stringify(staged))).toStrictEqual(staged);
    expect(staged).not.toHaveProperty("historyScanResumePage");
    expect(staged).not.toHaveProperty("historicAliasProgress");
  });

  it("carries a cleared cursor through the stage as null", () => {
    const staged = toStagedCollection(
      {
        ...publication,
        historyScanResumePage: null,
        historyScanResumeBoundaryReportCode: null,
        rankedBackfillCursor: null
      },
      undefined
    );
    const republished = fromStagedCollection(
      JSON.parse(JSON.stringify(staged)) as typeof staged
    );

    expect(republished).toMatchObject({
      historyScanResumePage: null,
      historyScanResumeBoundaryReportCode: null,
      rankedBackfillCursor: null
    });
    expect(republished).not.toHaveProperty("historicAliasProgress");
  });
});
