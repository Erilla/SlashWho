// @vitest-environment jsdom

import type { CharacterKey, DossierCharacter } from "@slashwho/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useCharacterVisibility } from "./use-character-visibility";

const root: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const ryalts: CharacterKey = { region: "eu", realm: "draenor", name: "ryalts" };
const benched: CharacterKey = {
  region: "eu",
  realm: "draenor",
  name: "benched"
};
const storageKey = "slashwho:dossier-hidden-characters:eu/silvermoon/ryii";

function row(key: CharacterKey, excluded = false): DossierCharacter {
  return {
    key,
    displayName: key.name,
    className: null,
    raiderIoUrl: `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`,
    source: "raiderio_declared",
    ...(excluded ? { excluded: true as const } : {})
  };
}

const characters = [row(root), row(ryalts), row(benched, true)];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("keeps the hidden characters for the dossier across a reload", () => {
  const first = renderHook(() => useCharacterVisibility(root, characters));
  act(() => first.result.current.toggle(ryalts));
  expect(first.result.current.isHidden(ryalts)).toBe(true);
  expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual([
    "eu/draenor/ryalts"
  ]);
  first.unmount();

  const reloaded = renderHook(() => useCharacterVisibility(root, characters));
  expect(reloaded.result.current.isHidden(ryalts)).toBe(true);
  expect(reloaded.result.current.isHidden(root)).toBe(false);
});

it("keeps each dossier's filter to itself", () => {
  window.localStorage.setItem(
    storageKey,
    JSON.stringify(["eu/draenor/ryalts"])
  );
  const other = renderHook(() =>
    useCharacterVisibility({ ...root, name: "other" }, characters)
  );
  expect(other.result.current.hidden.size).toBe(0);
});

it("shows only one character, hides only one, and shows them all again", () => {
  const { result } = renderHook(() => useCharacterVisibility(root, characters));

  act(() => result.current.showOnly(ryalts));
  expect([...result.current.hidden]).toEqual(["eu/silvermoon/ryii"]);

  act(() => result.current.hideOnly(ryalts));
  expect([...result.current.hidden]).toEqual(["eu/draenor/ryalts"]);

  act(() => result.current.showAll());
  expect(result.current.hidden.size).toBe(0);
  expect(window.localStorage.getItem(storageKey)).toBeNull();
});

it("ignores stored values it cannot read", () => {
  window.localStorage.setItem(storageKey, "{not json");
  expect(
    renderHook(() => useCharacterVisibility(root, characters)).result.current
      .hidden.size
  ).toBe(0);
  cleanup();

  window.localStorage.setItem(
    storageKey,
    JSON.stringify(["eu/draenor/ryalts", 4])
  );
  expect([
    ...renderHook(() => useCharacterVisibility(root, characters)).result.current
      .hidden
  ]).toEqual(["eu/draenor/ryalts"]);
});

it("still filters for the visit when storage refuses", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const { result } = renderHook(() => useCharacterVisibility(root, characters));

  act(() => result.current.toggle(ryalts));

  expect(result.current.isHidden(ryalts)).toBe(true);
});

it("does not count a stored character the list no longer holds as hidden", () => {
  window.localStorage.setItem(
    storageKey,
    JSON.stringify(["eu/draenor/unlinked"])
  );
  const { result } = renderHook(() => useCharacterVisibility(root, characters));
  expect(result.current.hidden.size).toBe(1);
  expect(result.current.anyHidden).toBe(false);
});

it("forgets a character once it is excluded, so it comes back visible", () => {
  window.localStorage.setItem(
    storageKey,
    JSON.stringify(["eu/draenor/ryalts", "eu/draenor/benched"])
  );
  const { result, rerender } = renderHook(
    ({ rows }) => useCharacterVisibility(root, rows),
    { initialProps: { rows: characters } }
  );
  expect([...result.current.hidden]).toEqual(["eu/draenor/ryalts"]);
  expect(result.current.anyHidden).toBe(true);

  rerender({ rows: [row(root), row(ryalts, true), row(benched, true)] });
  expect(result.current.hidden.size).toBe(0);
  expect(result.current.anyHidden).toBe(false);
  expect(window.localStorage.getItem(storageKey)).toBeNull();

  rerender({ rows: [row(root), row(ryalts), row(benched, true)] });
  expect(result.current.isHidden(ryalts)).toBe(false);
});
