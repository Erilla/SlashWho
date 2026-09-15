// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

  it("renders the captured dossier without any network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(DemoPage());

    // The captured fixture is a full real dossier (~150k lines of JSON),
    // so mounting it is CPU-bound work that can run well past the default
    // timeouts on a loaded CI runner, even though nothing here is async.
    expect(
      await screen.findByRole(
        "heading",
        { level: 1, name: "Ryii" },
        { timeout: 15_000 }
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Connected characters" })
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("omits the add character action so the demo cannot mutate real data", () => {
    render(DemoPage());

    expect(
      screen.queryByRole("button", { name: "Add character" })
    ).not.toBeInTheDocument();
  }, 20_000);
});
