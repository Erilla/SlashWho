// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UpstreamIconLink } from "./upstream-icon-link";

afterEach(cleanup);

describe("UpstreamIconLink", () => {
  it("renders the brand-provided Raider.IO mark", () => {
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
    const icon = link.querySelector("img");

    expect(icon).toHaveAttribute("src", "/brand/raiderio-mark.png");
    expect(icon).toHaveAttribute("alt", "");
    expect(link.querySelector("svg")).not.toBeInTheDocument();
  });

  it("renders the brand-provided Warcraft Logs mark", () => {
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
    const icon = link.querySelector("img");

    expect(icon).toHaveAttribute("src", "/brand/warcraft-logs-mark.png");
    expect(icon).toHaveAttribute("alt", "");
    expect(link.querySelector("svg")).not.toBeInTheDocument();
  });

  it("renders a square green kill status icon for report evidence", () => {
    render(
      <UpstreamIconLink
        evidenceState="kill"
        href="https://www.warcraftlogs.com/reports/abc123"
        label="View Warcraft Logs report"
        source="warcraft_logs"
      />
    );

    const link = screen.getByRole("link", {
      name: "View Warcraft Logs report (opens in a new tab)"
    });
    const icon = link.querySelector("svg");

    expect(icon).toHaveClass("upstream-link-icon--evidence-kill");
    expect(icon).toHaveAttribute("aria-label", "Kill report");
    expect(icon?.querySelector("rect")).toBeInTheDocument();
    expect(icon?.querySelector("path")).toBeInTheDocument();
    expect(link.querySelector("img")).not.toBeInTheDocument();
  });

  it("renders a square grey wipe status icon for report evidence", () => {
    render(
      <UpstreamIconLink
        evidenceState="wipe"
        href="https://www.warcraftlogs.com/reports/abc123"
        label="View Warcraft Logs wipe report"
        source="warcraft_logs"
      />
    );

    const link = screen.getByRole("link", {
      name: "View Warcraft Logs wipe report (opens in a new tab)"
    });
    const icon = link.querySelector("svg");

    expect(icon).toHaveClass("upstream-link-icon--evidence-wipe");
    expect(icon).toHaveAttribute("aria-label", "Wipe report");
    expect(icon?.querySelector("rect")).toBeInTheDocument();
    expect(icon?.querySelector("path")).toBeInTheDocument();
    expect(link.querySelector("img")).not.toBeInTheDocument();
  });
});
