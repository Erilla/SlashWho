// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { AddConnectedCharacterDialog } from "./add-connected-character-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const root = { region: "eu", realm: "silvermoon", name: "ryii" } as const;

function renderDialog(
  overrides: Partial<Parameters<typeof AddConnectedCharacterDialog>[0]> = {}
) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  render(
    <AddConnectedCharacterDialog
      connectedCharacters={[]}
      onAdded={onAdded}
      onClose={onClose}
      open
      root={root}
      {...overrides}
    />
  );
  return { onAdded, onClose };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function enterCharacter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("textbox", { name: "Character/URL" }));
  await user.paste("https://raider.io/characters/eu/silvermoon/Ryalts");
}

it("names the dialog so assistive technology announces its purpose", () => {
  renderDialog();

  expect(
    screen.getByRole("dialog", { name: "Add connected character" })
  ).toBeVisible();
});

it("is absent from the accessibility tree until it is opened", () => {
  renderDialog({ open: false });

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Character/URL" })
  ).not.toBeInTheDocument();
});

it("moves focus to the first field when it opens", async () => {
  renderDialog();

  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Character/URL" })).toHaveFocus()
  );
});

it("closes when the viewer presses Escape", async () => {
  // Break caught: a modal that traps the viewer with no keyboard exit fails
  // the dialog contract in #148.
  const user = userEvent.setup();
  const { onClose } = renderDialog();

  await user.keyboard("{Escape}");

  expect(onClose).toHaveBeenCalled();
});

it("closes when the viewer chooses Cancel", async () => {
  const user = userEvent.setup();
  const { onClose } = renderDialog();

  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(onClose).toHaveBeenCalled();
});

it("rejects an entry that is not a character without calling the API", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  renderDialog();

  await user.type(
    screen.getByRole("textbox", { name: "Character/URL" }),
    "Ryalts"
  );
  await user.click(
    screen.getByRole("button", { name: "Add connected character" })
  );

  expect(
    screen.getByText(
      "Enter a valid character URL, or character name, realm, and region."
    )
  ).toBeVisible();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("names a character that is already connected instead of adding it again", async () => {
  // Break caught: the API answers a duplicate with the same ready response as a
  // fresh link, so without this the dialog would silently claim success.
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  renderDialog({
    connectedCharacters: [{ region: "eu", realm: "silvermoon", name: "ryalts" }]
  });

  await enterCharacter(user);
  await user.click(
    screen.getByRole("button", { name: "Add connected character" })
  );

  expect(
    screen.getByText("Ryalts is already connected to this dossier.")
  ).toBeVisible();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("stays open reporting progress while the character is still being researched", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse(202, {
        kind: "job",
        jobId: "3f0f9d4c-4c3e-4f5a-9b1e-9c2f8a7d6e5b",
        status: "queued"
      })
    )
  );
  const { onAdded, onClose } = renderDialog();

  await enterCharacter(user);
  await user.click(
    screen.getByRole("button", { name: "Add connected character" })
  );

  expect(
    await screen.findByText("Researching connected character…")
  ).toBeVisible();
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
  expect(onAdded).toHaveBeenCalled();
});

it("reports the character as added and closes once it is linked", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(jsonResponse(200, { kind: "ready" }))
  );
  const { onAdded, onClose } = renderDialog();

  await enterCharacter(user);
  await user.click(
    screen.getByRole("button", { name: "Add connected character" })
  );

  await waitFor(() => expect(onAdded).toHaveBeenCalled());
  expect(onClose).toHaveBeenCalled();
});

it("posts the canonical character URL for the entered identity", async () => {
  const user = userEvent.setup();
  const fetchMock = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, { kind: "ready" }));
  vi.stubGlobal("fetch", fetchMock);
  renderDialog();

  await enterCharacter(user);
  await user.click(
    screen.getByRole("button", { name: "Add connected character" })
  );

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [url, request] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/api/dossiers/eu/silvermoon/ryii/connected-characters");
  expect(JSON.parse(String(request.body))).toEqual({
    characterUrl: "https://www.warcraftlogs.com/character/eu/silvermoon/ryalts"
  });
});

it("surfaces the reason the server refused the character", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse(404, {
        error: { code: "search_failed", message: "That character is private." }
      })
    )
  );
  const { onClose } = renderDialog();

  await enterCharacter(user);
  await user.click(
    screen.getByRole("button", { name: "Add connected character" })
  );

  expect(await screen.findByText("That character is private.")).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
});

it("reports an unreachable server rather than failing silently", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  renderDialog();

  await enterCharacter(user);
  await user.click(
    screen.getByRole("button", { name: "Add connected character" })
  );

  expect(
    await screen.findByText(
      "The character could not be added. Please check your connection."
    )
  ).toBeVisible();
});
