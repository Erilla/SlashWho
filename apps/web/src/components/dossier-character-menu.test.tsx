// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { DossierCharacterMenu } from "./dossier-character-menu";

const root = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
const character = {
  key: { region: "eu", realm: "draenor", name: "ryalts" },
  displayName: "Ryalts",
  className: "Priest",
  raiderIoUrl: "https://raider.io/characters/eu/draenor/ryalts",
  source: "manually_added"
} as const;

const connectionsPath = "/api/dossiers/eu/silvermoon/ryii/connected-characters";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(
  response: { ok?: boolean; status?: number; body?: unknown } = {}
) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    headers: new Headers(),
    json: async () => response.body ?? { kind: "ready" }
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openMenu() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Actions for Ryalts" });
  await user.click(trigger);
  return { trigger, user };
}

it("keeps the menu closed until its trigger is used", () => {
  render(<DossierCharacterMenu character={character} root={root} />);

  const trigger = screen.getByRole("button", { name: "Actions for Ryalts" });
  expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("excludes the character from the evidence", async () => {
  const fetchMock = stubFetch();
  const onChanged = vi.fn();
  render(
    <DossierCharacterMenu
      character={character}
      onChanged={onChanged}
      root={root}
    />
  );

  const { user } = await openMenu();
  await user.click(screen.getByRole("menuitem", { name: "Exclude" }));

  expect(fetchMock).toHaveBeenCalledWith(connectionsPath, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      characterUrl: "https://raider.io/characters/eu/draenor/ryalts",
      excluded: true
    })
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("offers the reverse action for a character already excluded", async () => {
  const fetchMock = stubFetch();
  render(
    <DossierCharacterMenu
      character={{ ...character, excluded: true }}
      root={root}
    />
  );

  const { user } = await openMenu();
  expect(
    screen.queryByRole("menuitem", { name: "Exclude" })
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "Include" }));

  expect(fetchMock).toHaveBeenCalledWith(
    connectionsPath,
    expect.objectContaining({
      body: JSON.stringify({
        characterUrl: "https://raider.io/characters/eu/draenor/ryalts",
        excluded: false
      })
    })
  );
});

it("confirms a removal by naming the exact character", async () => {
  stubFetch();
  render(<DossierCharacterMenu character={character} root={root} />);

  const { user } = await openMenu();
  await user.click(screen.getByRole("menuitem", { name: "Remove…" }));

  const dialog = screen.getByRole("dialog", {
    name: "Remove connected character"
  });
  expect(dialog).toBeVisible();
  expect(dialog).toHaveTextContent("Ryalts");
  expect(dialog).toHaveTextContent("EU · draenor");
});

it("unlinks the character once the removal is confirmed", async () => {
  const fetchMock = stubFetch();
  const onChanged = vi.fn();
  render(
    <DossierCharacterMenu
      character={character}
      onChanged={onChanged}
      root={root}
    />
  );

  const { user } = await openMenu();
  await user.click(screen.getByRole("menuitem", { name: "Remove…" }));
  await user.click(screen.getByRole("button", { name: "Remove character" }));

  expect(fetchMock).toHaveBeenCalledWith(connectionsPath, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      characterUrl: "https://raider.io/characters/eu/draenor/ryalts"
    })
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

it("changes nothing when the removal is cancelled", async () => {
  const fetchMock = stubFetch();
  const onChanged = vi.fn();
  render(
    <DossierCharacterMenu
      character={character}
      onChanged={onChanged}
      root={root}
    />
  );

  const { trigger, user } = await openMenu();
  await user.click(screen.getByRole("menuitem", { name: "Remove…" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});

it("reports a link another reviewer has already removed", async () => {
  // Two reviewers can hold the same dossier, so a stale row must say what
  // happened instead of reporting a change it did not make.
  stubFetch({
    ok: false,
    status: 404,
    body: {
      error: {
        code: "connection_not_found",
        message: "The character is no longer linked to this dossier."
      }
    }
  });
  const onChanged = vi.fn();
  render(
    <DossierCharacterMenu
      character={character}
      onChanged={onChanged}
      root={root}
    />
  );

  const { user } = await openMenu();
  await user.click(screen.getByRole("menuitem", { name: "Exclude" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The character is no longer linked to this dossier."
  );
  expect(onChanged).not.toHaveBeenCalled();
});

it("reports an unreachable request without claiming the change was made", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const onChanged = vi.fn();
  render(
    <DossierCharacterMenu
      character={character}
      onChanged={onChanged}
      root={root}
    />
  );

  const { user } = await openMenu();
  await user.click(screen.getByRole("menuitem", { name: "Exclude" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The character could not be updated. Please check your connection."
  );
  expect(onChanged).not.toHaveBeenCalled();
});

it("closes the menu on Escape and returns focus to its trigger", async () => {
  render(<DossierCharacterMenu character={character} root={root} />);

  const { trigger, user } = await openMenu();
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");

  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
