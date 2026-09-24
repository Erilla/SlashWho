// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

import {
  CharacterIdentityFields,
  emptyCharacterIdentity,
  type CharacterIdentity
} from "./character-identity-fields";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The fields are controlled, so a fixed value would reset the input on every
 * keystroke and never assemble a pasted URL. Hold the identity the way the
 * real forms do and assert on what the user ends up seeing.
 */
function Harness({
  errorId,
  idPrefix = "connected-character",
  initial = emptyCharacterIdentity,
  invalid
}: {
  errorId?: string;
  idPrefix?: string;
  initial?: CharacterIdentity;
  invalid?: boolean;
}) {
  const [identity, setIdentity] = useState(initial);
  return (
    <CharacterIdentityFields
      errorId={errorId}
      idPrefix={idPrefix}
      invalid={invalid}
      onChange={setIdentity}
      value={identity}
    />
  );
}

const entered: CharacterIdentity = {
  character: "Ryii",
  name: "Ryii",
  realm: "",
  region: "eu"
};

it("hides the realm and region until a character is entered", () => {
  // Break caught: #148 asks the panel not to show idle fields, and the header
  // search reveals realm and region only once something is typed.
  render(<Harness />);

  expect(screen.getByRole("textbox", { name: "Character/URL" })).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: "Realm" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Region" })
  ).not.toBeInTheDocument();
});

it("reveals the realm and region once a character is typed", async () => {
  const user = userEvent.setup();
  render(<Harness />);

  await user.type(screen.getByRole("textbox", { name: "Character/URL" }), "R");

  expect(screen.getByRole("textbox", { name: "Realm" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Region" })).toBeVisible();
});

it("hides the revealed fields again when the character is cleared", async () => {
  const user = userEvent.setup();
  render(<Harness initial={entered} />);

  await user.clear(screen.getByRole("textbox", { name: "Character/URL" }));

  expect(
    screen.queryByRole("textbox", { name: "Realm" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Region" })
  ).not.toBeInTheDocument();
});

it("scopes control ids to the instance so two forms can share a page", () => {
  // Break caught: the header search renders on every page from layout.tsx, so
  // hardcoded ids would duplicate once the dossier panel renders its own copy.
  render(<Harness idPrefix="connected-character" initial={entered} />);

  expect(
    screen.getByRole("textbox", { name: "Character/URL" })
  ).toHaveAttribute("id", "connected-character-name");
  expect(screen.getByRole("textbox", { name: "Realm" })).toHaveAttribute(
    "id",
    "connected-character-realm"
  );
  expect(screen.getByRole("combobox", { name: "Region" })).toHaveAttribute(
    "id",
    "connected-character-region"
  );
});

it("splits a pasted character URL into its name, realm, and region", async () => {
  const user = userEvent.setup();
  render(<Harness />);

  const characterField = screen.getByRole("textbox", {
    name: "Character/URL"
  });
  await user.click(characterField);
  await user.paste("https://raider.io/characters/us/illidan/Ryalts");

  expect(characterField).toHaveValue("ryalts");
  expect(screen.getByRole("textbox", { name: "Realm" })).toHaveValue("illidan");
  expect(screen.getByRole("combobox", { name: "Region" })).toHaveValue("us");
});

it("keeps a typed character that is not a URL as entered", async () => {
  const user = userEvent.setup();
  render(<Harness />);

  await user.type(
    screen.getByRole("textbox", { name: "Character/URL" }),
    "Ryalts"
  );

  expect(screen.getByRole("textbox", { name: "Character/URL" })).toHaveValue(
    "Ryalts"
  );
  expect(screen.getByRole("textbox", { name: "Realm" })).toHaveValue("");
});

it("describes every control by the error it shares when one is given", () => {
  render(
    <Harness errorId="connected-character-error" initial={entered} invalid />
  );

  for (const control of [
    screen.getByRole("textbox", { name: "Character/URL" }),
    screen.getByRole("textbox", { name: "Realm" }),
    screen.getByRole("combobox", { name: "Region" })
  ]) {
    expect(control).toHaveAttribute(
      "aria-describedby",
      "connected-character-error"
    );
    expect(control).toHaveAttribute("aria-invalid", "true");
  }
});

const idUrl = "https://www.warcraftlogs.com/character/id/40989140";

function deferredFetch() {
  let respond!: (response: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>((input) =>
    String(input) === "/api/account/session"
      ? Promise.resolve(Response.json({ account: null }))
      : new Promise<Response>((resolve) => {
          respond = resolve;
        })
  );
  vi.stubGlobal("fetch", fetch);
  return { fetch, respond: (response: Response) => respond(response) };
}

it("shows a spinner and no realm or region while a pasted ID URL resolves", async () => {
  // Break caught: realm and region would appear empty beside an ID URL,
  // inviting the reviewer to type a guess over what Warcraft Logs will say.
  deferredFetch();
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole("textbox", { name: "Character/URL" }));
  await user.paste(idUrl);

  expect(
    screen.getByRole("status", { name: "Looking up Warcraft Logs character" })
  ).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Realm" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Region" })).toBeNull();
});

it("fills the name, realm and region Warcraft Logs resolves the ID to", async () => {
  const { fetch, respond } = deferredFetch();
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole("textbox", { name: "Character/URL" }));
  await user.paste(idUrl);
  respond(
    Response.json({
      characterId: 40989140,
      region: "us",
      realm: "illidan",
      name: "Ryun"
    })
  );

  expect(await screen.findByRole("textbox", { name: "Realm" })).toHaveValue(
    "illidan"
  );
  expect(screen.getByRole("textbox", { name: "Character/URL" })).toHaveValue(
    "Ryun"
  );
  expect(screen.getByRole("combobox", { name: "Region" })).toHaveValue("us");
  expect(screen.queryByRole("status")).toBeNull();
  expect(fetch).toHaveBeenCalledWith(
    "/api/warcraft-logs/characters/40989140",
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
});

it("sends the visitor's own Warcraft Logs key with the lookup", async () => {
  window.localStorage.setItem(
    "slashwho:api-credentials",
    JSON.stringify({
      wclClientId: "visitor-id",
      wclClientSecret: "visitor-secret"
    })
  );
  const { fetch } = deferredFetch();
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole("textbox", { name: "Character/URL" }));
  await user.paste(idUrl);

  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/warcraft-logs/characters/40989140",
      expect.anything()
    )
  );
  const lookup = fetch.mock.calls.find(([url]) =>
    String(url).startsWith("/api/warcraft-logs/characters/")
  );
  const headers = new Headers(lookup?.[1]?.headers);
  expect(headers.get("x-wcl-client-id")).toBe("visitor-id");
  window.localStorage.clear();
});

it.each([
  [404, "No Warcraft Logs character has that ID."],
  [
    503,
    "Warcraft Logs could not be reached. Enter the character's name and realm instead."
  ]
])("explains a lookup answered %i", async (status, message) => {
  const { respond } = deferredFetch();
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole("textbox", { name: "Character/URL" }));
  await user.paste(idUrl);
  respond(new Response(null, { status }));

  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("textbox", { name: "Character/URL" })
  ).toHaveAttribute("aria-invalid", "true");
});

it("abandons a lookup the reviewer typed over", async () => {
  // Break caught: a slow answer for an abandoned paste would overwrite the
  // character the reviewer went on to type.
  const { fetch, respond } = deferredFetch();
  const user = userEvent.setup();
  render(<Harness />);

  const characterField = screen.getByRole("textbox", { name: "Character/URL" });
  await user.click(characterField);
  await user.paste(idUrl);
  await user.clear(characterField);
  await user.type(characterField, "Ryii");
  respond(
    Response.json({
      characterId: 40989140,
      region: "us",
      realm: "illidan",
      name: "Ryun"
    })
  );

  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(characterField).toHaveValue("Ryii");
  expect(screen.getByRole("textbox", { name: "Realm" })).toHaveValue("");
});
