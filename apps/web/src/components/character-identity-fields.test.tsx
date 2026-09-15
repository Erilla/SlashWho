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
