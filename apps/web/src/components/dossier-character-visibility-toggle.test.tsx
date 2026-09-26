// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { DossierCharacter } from "@slashwho/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { DossierCharacterVisibilityToggle } from "./dossier-character-visibility-toggle";

afterEach(cleanup);

const ryalts: DossierCharacter = {
  key: { region: "eu", realm: "draenor", name: "ryalts" },
  displayName: "Ryalts",
  className: "Priest",
  raiderIoUrl: "https://raider.io/characters/eu/draenor/ryalts",
  source: "fingerprint_derived"
};

function renderToggle(
  overrides: Partial<
    Parameters<typeof DossierCharacterVisibilityToggle>[0]
  > = {}
) {
  const handlers = {
    onToggle: vi.fn(),
    onShowOnly: vi.fn(),
    onHideOnly: vi.fn(),
    onShowAll: vi.fn()
  };
  render(
    <DossierCharacterVisibilityToggle
      anyHidden={false}
      character={ryalts}
      hidden={false}
      {...handlers}
      {...overrides}
    />
  );
  return handlers;
}

it("toggles the character on a left click and says whether it is shown", async () => {
  const handlers = renderToggle();
  const eye = screen.getByRole("button", {
    name: "Show Ryalts in the evidence"
  });
  expect(eye).toHaveAttribute("aria-pressed", "true");

  await userEvent.click(eye);

  expect(handlers.onToggle).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("reports a hidden character as not pressed", () => {
  renderToggle({ hidden: true });
  expect(
    screen.getByRole("button", { name: "Show Ryalts in the evidence" })
  ).toHaveAttribute("aria-pressed", "false");
});

it("opens the menu on a right click with toggle, show only and hide only", async () => {
  const handlers = renderToggle();
  const eye = screen.getByRole("button", {
    name: "Show Ryalts in the evidence"
  });

  fireEvent.contextMenu(eye);

  const menu = screen.getByRole("menu", {
    name: "Evidence visibility for Ryalts"
  });
  expect(
    Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent
    )
  ).toEqual(["Hide Ryalts", "Show only Ryalts", "Hide only Ryalts"]);
  expect(screen.getByRole("menuitem", { name: "Hide Ryalts" })).toHaveFocus();

  await userEvent.click(
    screen.getByRole("menuitem", { name: "Show only Ryalts" })
  );

  expect(handlers.onShowOnly).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(eye).toHaveFocus();
});

it("offers the matching toggle and show all once something is hidden", async () => {
  const handlers = renderToggle({ hidden: true, anyHidden: true });

  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Show Ryalts in the evidence" })
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Show Ryalts" }));
  expect(handlers.onToggle).toHaveBeenCalledOnce();

  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Show Ryalts in the evidence" })
  );
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Hide only Ryalts" })
  );
  expect(handlers.onHideOnly).toHaveBeenCalledOnce();

  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Show Ryalts in the evidence" })
  );
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Show all characters" })
  );
  expect(handlers.onShowAll).toHaveBeenCalledOnce();
});

it("moves through the menu with the arrow keys and closes on Escape", async () => {
  const handlers = renderToggle();
  const eye = screen.getByRole("button", {
    name: "Show Ryalts in the evidence"
  });
  fireEvent.contextMenu(eye);

  await userEvent.keyboard("{ArrowDown}");
  expect(
    screen.getByRole("menuitem", { name: "Show only Ryalts" })
  ).toHaveFocus();
  await userEvent.keyboard("{End}");
  expect(
    screen.getByRole("menuitem", { name: "Hide only Ryalts" })
  ).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Hide Ryalts" })).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(eye).toHaveFocus();
  expect(handlers.onToggle).not.toHaveBeenCalled();
});

it("closes the menu on a click elsewhere without acting", async () => {
  const handlers = renderToggle();
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Show Ryalts in the evidence" })
  );

  await userEvent.click(document.body);

  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(
    Object.values(handlers).every((fn) => fn.mock.calls.length === 0)
  ).toBe(true);
});

it("disables the eye for an excluded character, which has no evidence to show", () => {
  renderToggle({ character: { ...ryalts, excluded: true } });
  expect(
    screen.getByRole("button", {
      name: "Ryalts is excluded, so has no evidence to show"
    })
  ).toBeDisabled();
});
