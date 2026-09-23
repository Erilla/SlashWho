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

  it("places an accessible validation error next to an invalid character value", async () => {
    const user = userEvent.setup();
    render(<SearchForm />);

    const input = screen.getByRole("textbox", { name: "Character/URL" });
    await user.type(input, "https://example.com/not-a-character");
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(input).toHaveAccessibleDescription(
      "Enter a valid character URL, or character name, realm, and region."
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid character URL, or character name, realm, and region."
    );
  });

  it("researches a pasted Warcraft Logs ID URL under the name it resolves to", async () => {
    // Break caught: an ID URL would be submitted as it stands, which the
    // dossier endpoint cannot parse, or before its realm is known.
    const user = userEvent.setup();
    let resolveLookup!: (response: Response) => void;
    const fetch = vi.fn((input: RequestInfo | URL) =>
      String(input).startsWith("/api/warcraft-logs/")
        ? new Promise<Response>((resolve) => {
            resolveLookup = resolve;
          })
        : Promise.resolve(
            Response.json(
              {
                kind: "job",
                jobId: "ca3ccfdf-1e8b-49b1-9729-459f42a104c0",
                status: "queued"
              },
              { status: 202 }
            )
          )
    );
    vi.stubGlobal("fetch", fetch);
    render(<SearchForm />);

    await user.click(screen.getByRole("textbox", { name: "Character/URL" }));
    await user.paste("https://www.warcraftlogs.com/character/id/40989140");
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();

    resolveLookup(
      Response.json({
        characterId: 40989140,
        region: "eu",
        realm: "silvermoon",
        name: "Ryun"
      })
    );
    await screen.findByRole("textbox", { name: "Realm" });
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(fetch).toHaveBeenLastCalledWith(
      "/api/dossiers",
      expect.objectContaining({
        body: JSON.stringify({
          characterUrl:
            "https://www.warcraftlogs.com/character/eu/silvermoon/ryun"
        })
      })
    );
    expect(push).toHaveBeenCalledWith(
      "/dossiers/eu/silvermoon/ryun?job=ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
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
      screen.getByRole("textbox", { name: "Character/URL" }),
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

  it("clears the character and realm fields after a successful navigation", async () => {
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

    const character = screen.getByRole("textbox", { name: "Character/URL" });
    await user.type(character, "Ryii");
    await user.type(
      screen.getByRole("textbox", { name: "Realm" }),
      "Silvermoon"
    );
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(push).toHaveBeenCalled();
    expect(character).toHaveValue("");
    expect(
      screen.queryByRole("textbox", { name: "Realm" })
    ).not.toBeInTheDocument();
  });

  it("keeps entered values when the request fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    render(<SearchForm />);

    const character = screen.getByRole("textbox", { name: "Character/URL" });
    await user.type(character, "Ryii");
    const realm = screen.getByRole("textbox", { name: "Realm" });
    await user.type(realm, "Silvermoon");
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(push).not.toHaveBeenCalled();
    expect(character).toHaveValue("Ryii");
    expect(realm).toHaveValue("Silvermoon");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The search could not be started. Please check your connection."
    );
  });

  it("keeps entered values while the research request is still pending", async () => {
    const user = userEvent.setup();
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
      )
    );
    render(<SearchForm />);

    const character = screen.getByRole("textbox", { name: "Character/URL" });
    await user.type(character, "Ryii");
    const realm = screen.getByRole("textbox", { name: "Realm" });
    await user.type(realm, "Silvermoon");
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(push).not.toHaveBeenCalled();
    expect(character).toHaveValue("Ryii");
    expect(realm).toHaveValue("Silvermoon");

    resolveFetch(
      new Response(
        JSON.stringify({
          kind: "job",
          jobId: "ca3ccfdf-1e8b-49b1-9729-459f42a104c0",
          status: "queued"
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )
    );
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    expect(character).toHaveValue("");
    expect(
      screen.queryByRole("textbox", { name: "Realm" })
    ).not.toBeInTheDocument();
  });

  it("resolves a pasted profile URL into the character fields", async () => {
    const user = userEvent.setup();
    render(<SearchForm />);

    const character = screen.getByRole("textbox", { name: "Character/URL" });
    expect(character).toHaveAttribute("placeholder", "Character/URL");
    expect(screen.queryByText("Character name")).not.toBeInTheDocument();

    await user.click(character);
    await user.paste("https://raider.io/characters/eu/silvermoon/Ryii");

    expect(character).toHaveValue("ryii");
    expect(screen.getByRole("textbox", { name: "Realm" })).toHaveValue(
      "silvermoon"
    );
    expect(screen.getByRole("combobox", { name: "Region" })).toHaveValue("eu");
  });

  it("supports structured character lookup and starts dossier research", async () => {
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

    expect(
      screen.getByRole("button", { name: "Research applicant" })
    ).toHaveTextContent("→");
    await user.type(
      screen.getByRole("textbox", { name: "Character/URL" }),
      "Ryii"
    );
    expect(screen.getByRole("combobox", { name: "Region" })).toHaveValue("eu");
    await user.type(
      screen.getByRole("textbox", { name: "Realm" }),
      "Silvermoon"
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Region" }), [
      "eu"
    ]);
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(push).toHaveBeenCalledWith(
      "/dossiers/eu/silvermoon/ryii?job=ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/dossiers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          characterUrl:
            "https://www.warcraftlogs.com/character/eu/silvermoon/ryii"
        })
      })
    );
  });

  it("reveals the realm and region fields only once a character is entered", async () => {
    const user = userEvent.setup();
    render(<SearchForm />);

    const character = screen.getByRole("textbox", { name: "Character/URL" });
    expect(
      screen.queryByRole("textbox", { name: "Realm" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Region" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Research applicant" })
    ).toBeInTheDocument();

    await user.type(character, "Ryii");

    expect(screen.getByRole("textbox", { name: "Realm" })).toHaveAttribute(
      "placeholder",
      "Realm"
    );
    expect(screen.getByRole("combobox", { name: "Region" })).toHaveValue("eu");

    await user.clear(character);

    expect(
      screen.queryByRole("textbox", { name: "Realm" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Region" })
    ).not.toBeInTheDocument();
  });

  it("rejects structured lookup when required fields are missing", async () => {
    const user = userEvent.setup();
    render(<SearchForm />);

    const character = screen.getByRole("textbox", { name: "Character/URL" });
    await user.type(character, "Ryii");
    await user.click(
      screen.getByRole("button", { name: "Research applicant" })
    );

    expect(push).not.toHaveBeenCalled();
    expect(character).toHaveValue("Ryii");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid character URL, or character name, realm, and region."
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
      screen.getByRole("textbox", { name: "Character/URL" }),
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
      screen.getByRole("textbox", { name: "Character/URL" }),
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
