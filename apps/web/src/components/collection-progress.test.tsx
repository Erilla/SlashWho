// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { CollectionPhase } from "@slashwho/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";

import { CollectionProgress } from "./collection-progress";

afterEach(cleanup);

const midRun: CollectionPhase[] = [
  { id: "warcraft_logs_identity_resolution", state: "completed" },
  { id: "warcraft_logs_history", state: "completed" },
  { id: "warcraft_logs_tier_bests", state: "skipped" },
  {
    id: "warcraft_logs_fight_parses",
    state: "limited",
    limitationCode: "parse_request_cap"
  },
  { id: "warcraft_logs_ranking_identities", state: "active" },
  { id: "raiderio_rankings", state: "pending" },
  { id: "publication", state: "pending" }
];

it("shows the current step and keeps the checklist collapsed", () => {
  render(<CollectionProgress phases={midRun} subject="Ryii" />);

  expect(
    screen.getByText("Matching ranking identities", {
      selector: "summary > span"
    })
  ).toBeVisible();
  expect(screen.getByRole("group")).not.toHaveAttribute("open");
  expect(screen.getByRole("list", { hidden: true })).not.toBeVisible();
});

it("lists every step with its state, and the limitation on the step that raised it", async () => {
  render(<CollectionProgress phases={midRun} subject="Ryii" />);

  await userEvent.click(
    screen.getByText("Matching ranking identities", {
      selector: "summary > span"
    })
  );
  const items = within(screen.getByRole("list")).getAllByRole("listitem");

  expect(items.map((item) => item.textContent)).toEqual([
    "Resolving the character on Warcraft Logs: done",
    "Scanning report history: done",
    "Reading tier bests: skipped",
    "Reading per-fight parses: limited, request cap reached",
    "Matching ranking identities: in progress",
    "Reading Raider.IO rankings: to do",
    "Publishing evidence: to do"
  ]);
});

it("announces a step transition, not every poll within a step", () => {
  const { rerender } = render(
    <CollectionProgress phases={midRun} subject="Ryii" />
  );
  const status = screen.getByRole("status");
  // The step the run was on when the page loaded is not news.
  expect(status).toBeEmptyDOMElement();

  // Nor is the same step on a later poll.
  rerender(<CollectionProgress phases={[...midRun]} subject="Ryii" />);
  expect(status).toBeEmptyDOMElement();

  rerender(
    <CollectionProgress
      phases={midRun.map((phase) =>
        phase.id === "warcraft_logs_ranking_identities"
          ? { ...phase, state: "completed" }
          : phase.id === "raiderio_rankings"
            ? { ...phase, state: "active" }
            : phase
      )}
      subject="Ryii"
    />
  );
  expect(status).toHaveTextContent("Ryii: Reading Raider.IO rankings");
});

it("stays silent where many runs update at once", () => {
  render(
    <CollectionProgress announce={false} phases={midRun} subject="Ryii" />
  );

  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it.each([
  [
    "a run no worker has claimed",
    [
      { id: "warcraft_logs_identity_resolution", state: "pending" },
      { id: "publication", state: "pending" }
    ],
    "Waiting to start"
  ],
  [
    "a run between steps",
    [
      { id: "warcraft_logs_identity_resolution", state: "completed" },
      {
        id: "warcraft_logs_history",
        state: "limited",
        limitationCode: "rate_limited"
      },
      { id: "publication", state: "pending" }
    ],
    "Next: Publishing evidence"
  ],
  [
    "a run that stopped",
    [
      { id: "warcraft_logs_identity_resolution", state: "completed" },
      { id: "warcraft_logs_history", state: "failed" },
      { id: "publication", state: "pending" }
    ],
    "Stopped at Scanning report history"
  ]
] satisfies [string, CollectionPhase[], string][])(
  "summarises %s",
  (_case, phases, summary) => {
    render(
      <CollectionProgress announce={false} phases={phases} subject="Ryii" />
    );

    expect(screen.getByText(summary)).toBeVisible();
  }
);
