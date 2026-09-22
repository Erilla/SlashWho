// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicantDossierSchema } from "@slashwho/contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() })
}));

import DemoPage from "./page";
import fixture from "./ryii-dossier.json";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("demo page", () => {
  it("keeps the captured dossier valid against the published contract", () => {
    const parsed = applicantDossierSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
  });

  it("redacts email-form identities from the frozen capture", () => {
    // Break caught: a public report's uploader field can contain a personal
    // email address, which must not become part of the committed demo data.
    expect(JSON.stringify(fixture)).not.toMatch(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    );
  });

  it("renders the captured dossier without any network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(DemoPage());

    // The captured fixture is a full real dossier (~150k lines of JSON),
    // so mounting it is CPU-bound work that can run well past the default
    // timeouts on a loaded CI runner, even though nothing here is async.
    expect(
      await screen.findByRole(
        "heading",
        { level: 1, name: /Ryii/ },
        { timeout: 15_000 }
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Connected characters" })
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("shows public report uploaders in Twin Fangs evidence", async () => {
    // Break caught: an outdated frozen capture silently drops public uploader
    // names and the rendered report menu falls back to “Unknown uploader”.
    const user = userEvent.setup();

    render(DemoPage());

    const evidence = await screen.findByRole(
      "group",
      { name: "The Twin Fangs evidence" },
      { timeout: 15_000 }
    );
    await user.click(within(evidence).getByText("View kill evidence"));
    await user.click(
      within(evidence).getByRole("button", {
        name: "Choose from 3 kill reports"
      })
    );

    const reports = screen.getByRole("list", { name: "Kill reports" });
    expect(
      within(reports).getByRole("link", {
        name: "Rancour — Guild log uploaded by binded"
      })
    ).toBeVisible();
    expect(
      within(reports).getByRole("link", {
        name: "Lflilkitty, personal log"
      })
    ).toBeVisible();
    expect(
      within(reports).getByRole("link", {
        name: "d4mnBoY, personal log"
      })
    ).toBeVisible();
  }, 20_000);

  it("omits the add character action so the demo cannot mutate real data", () => {
    render(DemoPage());

    expect(
      screen.queryByRole("button", { name: "Add character" })
    ).not.toBeInTheDocument();
  }, 20_000);
});
