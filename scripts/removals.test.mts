import { expect, it } from "vitest";

import { parseRemovalOperation } from "./removals.mts";

it("accepts the documented pnpm separator before the removal command", () => {
  // Break caught: pnpm forwards the literal `--`, so the documented maintainer
  // command failed with removal_command_required and no removal was applied.
  expect(
    parseRemovalOperation([
      "--",
      "add",
      "https://raider.io/characters/eu/silvermoon/Ryii",
      "--reason",
      "github-issue-123"
    ])
  ).toEqual({
    command: "add",
    characterUrl: "https://raider.io/characters/eu/silvermoon/Ryii",
    reason: "github-issue-123",
    expiresAt: null
  });
});

it("parses a time-bounded suppression expiry", () => {
  // Break caught: an unparsed expiry would silently become a permanent removal.
  expect(
    parseRemovalOperation([
      "add",
      "https://raider.io/characters/eu/silvermoon/Ryii",
      "--reason",
      "github-issue-123",
      "--expires-at",
      "2027-01-01T00:00:00Z"
    ]).expiresAt
  ).toEqual(new Date("2027-01-01T00:00:00.000Z"));
  expect(() =>
    parseRemovalOperation([
      "add",
      "https://raider.io/characters/eu/silvermoon/Ryii",
      "--reason",
      "github-issue-123",
      "--expires-at",
      "not-a-date"
    ])
  ).toThrow("removal_expiry_invalid");
});

it("refuses operations without a command, character, or reason", () => {
  // Break caught: an ad-hoc invocation could suppress the wrong identity or
  // record an unauditable removal reason.
  expect(() => parseRemovalOperation(["--"])).toThrow(
    "removal_command_required"
  );
  expect(() => parseRemovalOperation(["delete", "x"])).toThrow(
    "removal_command_required"
  );
  expect(() => parseRemovalOperation(["audit"])).toThrow(
    "character_url_required"
  );
  expect(() =>
    parseRemovalOperation([
      "add",
      "https://raider.io/characters/eu/silvermoon/Ryii"
    ])
  ).toThrow("removal_reason_invalid");
  expect(() =>
    parseRemovalOperation([
      "add",
      "https://raider.io/characters/eu/silvermoon/Ryii",
      "--reason",
      "r".repeat(129)
    ])
  ).toThrow("removal_reason_invalid");
});
