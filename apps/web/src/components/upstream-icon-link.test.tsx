// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UpstreamIconLink } from "./upstream-icon-link";

afterEach(cleanup);

describe("UpstreamIconLink", () => {
  it("renders the official Raider.IO mark", () => {
    render(
      <UpstreamIconLink
        href="https://raider.io/characters/eu/silvermoon/ryii"
        label="View Ryii on Raider.IO"
        source="raiderio"
      />
    );

    const link = screen.getByRole("link", {
      name: "View Ryii on Raider.IO (opens in a new tab)"
    });
    const icon = link.querySelector("svg");

    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icon?.querySelectorAll("path")).toHaveLength(3);
    expect(icon?.querySelector('path[d^="M12 2"]')).toBeInTheDocument();
  });

  it("renders the official Warcraft Logs mark", () => {
    render(
      <UpstreamIconLink
        href="https://www.warcraftlogs.com/reports/abc123"
        label="View Warcraft Logs report"
        source="warcraft_logs"
      />
    );

    const link = screen.getByRole("link", {
      name: "View Warcraft Logs report (opens in a new tab)"
    });
    const icon = link.querySelector("svg");

    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icon?.querySelectorAll("path")).toHaveLength(4);
    expect(icon?.querySelector('path[d^="M12 4.5"]')).toBeInTheDocument();
  });
});
