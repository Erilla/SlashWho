// @vitest-environment jsdom

import type { DossierLimitation } from "@slashwho/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DossierLimitations } from "./dossier-limitations";

const requestCap: DossierLimitation = {
  source: "warcraft_logs",
  character: null,
  code: "request_cap",
  message: "Warcraft Logs history is incomplete.",
  affects: "kill_history",
  recovery: "automatic",
  observedAt: "2026-09-15T12:00:00.000Z"
};

afterEach(cleanup);

describe("DossierLimitations", () => {
  it("shows the date and time each limitation was observed", () => {
    // Break caught (#526): a date alone hides how old an observation is on
    // the day it was made, which is when these change fastest.
    render(<DossierLimitations limitations={[requestCap]} />);

    expect(screen.getByText("15 Sept 2026, 12:00 UTC")).toBeTruthy();
  });

  it("says what each limitation affects, where it came from and how it recovers", () => {
    render(
      <DossierLimitations
        limitations={[
          {
            ...requestCap,
            code: "parse_rate_limited",
            message: "Parse availability is partial.",
            affects: "parses",
            character: { region: "eu", realm: "silvermoon", name: "ryii" },
            retryAt: "2026-09-15T12:15:00.000Z"
          },
          {
            ...requestCap,
            source: "blizzard",
            code: "not_found",
            message: "Blizzard achievement data has no public evidence.",
            affects: "cutting_edge",
            recovery: "none"
          }
        ]}
      />
    );

    const [parses, cuttingEdge] = screen
      .getAllByRole("listitem")
      .filter((item) => item.classList.contains("dossier-limitation"));
    expect(within(parses!).getByText("Warcraft Logs")).toBeTruthy();
    expect(within(parses!).getByText("Parses")).toBeTruthy();
    expect(within(parses!).getByText("Ryii")).toBeTruthy();
    expect(within(parses!).getByText("Retries automatically")).toBeTruthy();
    expect(within(parses!).getByText("15 Sept 2026, 12:15 UTC")).toBeTruthy();
    expect(within(cuttingEdge!).getByText("Blizzard")).toBeTruthy();
    expect(within(cuttingEdge!).getByText("Cutting Edge status")).toBeTruthy();
    expect(
      within(cuttingEdge!).getByText("Waiting will not change this")
    ).toBeTruthy();
  });

  it("lists every character a shortfall applies to under one entry", () => {
    // Break caught: a capped roster repeated the same sentence once per
    // character, burying who was affected and when under the repetition.
    render(
      <DossierLimitations
        limitations={[
          {
            ...requestCap,
            character: { region: "eu", realm: "silvermoon", name: "ryii" }
          },
          {
            ...requestCap,
            character: { region: "eu", realm: "silvermoon", name: "riln" },
            observedAt: "2026-09-15T13:30:00.000Z"
          }
        ]}
      />
    );

    const entries = screen
      .getAllByRole("listitem")
      .filter((item) => item.classList.contains("dossier-limitation"));
    expect(entries).toHaveLength(1);
    expect(
      within(entries[0]!).getAllByText("Warcraft Logs history is incomplete.")
    ).toHaveLength(1);
    expect(within(entries[0]!).getByText("Ryii")).toBeTruthy();
    expect(within(entries[0]!).getByText("Riln")).toBeTruthy();
    expect(
      within(entries[0]!).getByText("15 Sept 2026, 13:30 UTC")
    ).toBeTruthy();
  });

  it("lists the affected encounters and summarises the rest past the first few", () => {
    const encounters = Array.from({ length: 8 }, (_, index) => ({
      raidName: "Nerub-ar Palace",
      bossName: `Boss ${index + 1}`,
      kills: index === 0 ? 1 : 2
    }));
    render(
      <DossierLimitations
        limitations={[
          {
            ...requestCap,
            code: "current_content_evidence_withheld",
            affects: "hidden_kills",
            recovery: "none",
            encounters
          }
        ]}
      />
    );

    const list = screen.getByRole("list", { name: "Affected encounters" });
    expect(within(list).getByText("Nerub-ar Palace · Boss 1")).toBeTruthy();
    expect(within(list).getByText("1 kill")).toBeTruthy();
    expect(within(list).queryByText("Nerub-ar Palace · Boss 7")).toBeNull();
    expect(
      within(list).getByText("and 2 more encounters (4 kills)")
    ).toBeTruthy();
    expect(screen.getByText("Kills not shown")).toBeTruthy();
  });

  it("names a raid as a whole when the shortfall has no boss", () => {
    render(
      <DossierLimitations
        limitations={[
          {
            ...requestCap,
            encounters: [
              { raidName: "Liberation of Undermine", bossName: null, kills: 3 }
            ]
          }
        ]}
      />
    );

    expect(screen.getByText("Liberation of Undermine")).toBeTruthy();
    expect(screen.getByText("3 kills")).toBeTruthy();
  });
});
