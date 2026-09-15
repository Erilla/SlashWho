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

// Rendering the frozen dossier is the heaviest render in the suite: the whole
// raid catalogue at once, three times over. On a loaded machine it sits close
// to the 5s default, so this file gets room rather than a timing flake.
describe("demo page", { timeout: 20_000 }, () => {
  it("keeps the captured dossier valid against the published contract", () => {
    const parsed = applicantDossierSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
  });

  it("renders the captured dossier without any network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(DemoPage());

    expect(
      await screen.findByRole("heading", { level: 1, name: "Ryii" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Connected characters" })
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("omits the add character action so the demo cannot mutate real data", () => {
    render(DemoPage());

    expect(
      screen.queryByRole("button", { name: "Add character" })
    ).not.toBeInTheDocument();
  });
});
