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

  it("places an accessible validation error next to an invalid URL", async () => {
    const user = userEvent.setup();
    render(<SearchForm />);

    const input = screen.getByRole("textbox", {
      name: "Raider.IO character URL"
    });
    await user.type(input, "https://example.com/not-a-character");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(input).toHaveAccessibleDescription(
      "Enter a Raider.IO character URL."
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a Raider.IO character URL."
    );
  });

  it("submits with Enter and navigates to the canonical character route", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            kind: "job",
            jobId: "ca3ccfdf-1e8b-49b1-9729-459f42a104c0",
            status: "queued",
            statusUrl: "/api/v1/searches/ca3ccfdf-1e8b-49b1-9729-459f42a104c0",
            characterUrl: "/characters/eu/silvermoon/ryii"
          }),
          { status: 202, headers: { "content-type": "application/json" } }
        )
      )
    );
    render(<SearchForm />);

    await user.type(
      screen.getByRole("textbox", { name: "Raider.IO character URL" }),
      "https://raider.io/characters/EU/Silvermoon/Ryii{Enter}"
    );

    expect(push).toHaveBeenCalledWith(
      "/characters/eu/silvermoon/ryii?job=ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
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
      screen.getByRole("textbox", { name: "Raider.IO character URL" }),
      "https://raider.io/characters/eu/silvermoon/Ryii"
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many searches. Try again in 42 seconds."
    );
  });
});
