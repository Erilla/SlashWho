import { describe, expect, it } from "vitest";

import { guildAttendancePage, guildReportsPage } from "./attendance";

const attendance = (data: unknown[]) => ({
  data: {
    guildData: { guild: { attendance: { data, has_more_pages: false } } }
  }
});

describe("reading an attendance page", () => {
  it("rules a report out only when a readable list lacks the character", () => {
    // Moved from the recovery suite when recovery stopped reading attendance
    // (#712); the tier search still walks it.
    const page = guildAttendancePage(
      attendance([
        { code: "listed", players: [{ name: "Sentinel" }] },
        { code: "strangers", players: [{ name: "Other" }] },
        { code: "shouted", players: [{ name: "SENTINEL" }] },
        // Not listing players is not listing the character's absence.
        { code: "unlisted" },
        { code: "emptyList", players: [] },
        { code: "malformedList", players: [{ name: null }] },
        {
          code: "suffixed",
          players: [{ name: "Other" }, { name: "Sentinel-Silvermoon" }]
        }
      ]),
      "sentinel"
    );

    expect(
      page?.reports.map(({ code, listsCharacter }) => [code, listsCharacter])
    ).toEqual([
      ["listed", true],
      ["strangers", false],
      ["shouted", true],
      ["unlisted", null],
      ["emptyList", null],
      ["malformedList", null],
      ["suffixed", true]
    ]);
  });

  it("matches a name written in another Unicode form", () => {
    // Break caught: a decomposed accent is a different string, so an exact
    // comparison would rule out the very report attendance exists to find.
    const page = guildAttendancePage(
      attendance([{ code: "decomposed", players: [{ name: "Zoë" }] }]),
      "zoë"
    );

    expect(page?.reports[0]?.listsCharacter).toBe(true);
  });
});

describe("reading a guild's report listing", () => {
  const listing = (reports: unknown, hasMorePages: unknown = false) => ({
    data: {
      reportData: { reports: { data: reports, has_more_pages: hasMorePages } }
    }
  });

  it("reads each report's code and start", () => {
    expect(
      guildReportsPage(
        listing(
          [
            { code: "dated", startTime: 1_739_210_580_662 },
            { code: "undated", startTime: null }
          ],
          true
        )
      )
    ).toEqual({
      reports: [
        { code: "dated", startTime: 1_739_210_580_662 },
        { code: "undated", startTime: null }
      ],
      hasMorePages: true
    });
  });

  it("cannot read a page without its reports, its paging or a code", () => {
    // Recorded 2026-09-28: an unknown guild answers `reports: null` beside
    // its error, and the transport reads the error first.
    for (const value of [
      { data: { reportData: { reports: null } } },
      { data: { reportData: { reports: { data: [] } } } },
      listing([{ startTime: 1 }]),
      listing([{ code: "" }]),
      null
    ]) {
      expect(guildReportsPage(value)).toBeNull();
    }
  });
});
