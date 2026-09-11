// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push })
}));

import { SearchForm } from "./search-form";

describe("SearchForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    push.mockReset();
  });

  it("places an accessible validation error next to an invalid applicant URL", async () => {
    const user = userEvent.setup();
    render(<SearchForm />);

    const input = screen.getByRole("textbox", {
      name: "Applicant URL"
    });
    await user.type(input, "https://example.com/not-a-character");
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(input).toHaveAccessibleDescription(
      "Enter a Raider.IO or Warcraft Logs character URL."
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a Raider.IO or Warcraft Logs character URL."
    );
  });

  it("submits a Raider.IO applicant URL and navigates to its dossier", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            kind: "job",
            jobId: "ca3ccfdf-1e8b-49b1-9729-459f42a104c0",
            status: "queued"
          }),
          { status: 202, headers: { "content-type": "application/json" } }
        )
      )
    );
    render(<SearchForm />);

    await user.type(
      screen.getByRole("textbox", { name: "Applicant URL" }),
      "https://raider.io/characters/EU/Silvermoon/Ryii"
    );
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(push).toHaveBeenCalledWith(
      "/dossiers/eu/silvermoon/ryii?job=ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/dossiers",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("submits a Warcraft Logs applicant URL and navigates to its dossier", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            kind: "job",
            jobId: "ca3ccfdf-1e8b-49b1-9729-459f42a104c0",
            status: "queued"
          }),
          { status: 202, headers: { "content-type": "application/json" } }
        )
      )
    );
    render(<SearchForm />);

    await user.type(
      screen.getByRole("textbox", { name: "Applicant URL" }),
      "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii"
    );
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(push).toHaveBeenCalledWith(
      "/dossiers/eu/silvermoon/ryii?job=ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
    );
  });

  it("shows the retry window returned by a rate-limited search", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "rate_limited", message: "Too many requests." }
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "42"
            }
          }
        )
      )
    );
    render(<SearchForm />);

    await user.type(
      screen.getByRole("textbox", { name: "Applicant URL" }),
      "https://raider.io/characters/eu/silvermoon/Ryii"
    );
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many searches. Try again in 42 seconds."
    );
  });
});
