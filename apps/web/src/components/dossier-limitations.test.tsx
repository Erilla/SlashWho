// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DossierLimitations } from "./dossier-limitations";

describe("DossierLimitations", () => {
  it("shows when each limitation was observed", () => {
    render(
      <DossierLimitations
        limitations={[
          {
            source: "warcraft_logs",
            character: null,
            code: "request_cap",
            message: "Warcraft Logs history is incomplete.",
            observedAt: "2026-09-15T12:00:00.000Z"
          }
        ]}
      />
    );

    expect(screen.getByText("Observed 15 Sept 2026.")).toBeTruthy();
  });
});
