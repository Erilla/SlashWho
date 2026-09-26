import { expect, it } from "vitest";
import {
  applicantParserVersion,
  parseApplicantCandidates
} from "./applicant-candidates";

it("extracts distinct supported characters and ignores unrelated links", () => {
  const result = parseApplicantCandidates(
    "(https://raider.io/characters/eu/example/aria?view=1), https://www.warcraftlogs.com/character/eu/example/aria#latest https://www.warcraftlogs.com/character/id/42. https://www.warcraftlogs.com/reports/abc"
  );
  expect(result.candidates.map((candidate) => candidate.identity)).toEqual([
    'character:["eu","example","aria"]',
    "warcraftlogs_id:42"
  ]);
  expect(result.invalid).toBe(0);
});

it("bounds parsing and never returns raw text", () => {
  const result = parseApplicantCandidates("private answer ".repeat(400));
  expect(result).toEqual({ candidates: [], invalid: 0, truncated: true });
});

it("finds supported links after sixteen unrelated or duplicate URLs", () => {
  const unrelated = Array.from(
    { length: 17 },
    () => "https://www.warcraftlogs.com/reports/abc"
  );
  const result = parseApplicantCandidates(
    [...unrelated, "https://raider.io/characters/eu/example/late"].join(" ")
  );
  expect(result.candidates.map((candidate) => candidate.identity)).toEqual([
    'character:["eu","example","late"]'
  ]);
  expect(result.truncated).toBe(false);
});

it("accepts an accented Raider.IO realm as the character on Blizzard's slug", () => {
  const result = parseApplicantCandidates(
    "https://raider.io/characters/eu/aggra-portugu%C3%AAs/Aria https://www.warcraftlogs.com/character/eu/aggra-portugues/aria"
  );
  expect(result.candidates.map((candidate) => candidate.identity)).toEqual([
    'character:["eu","aggra-portugues","aria"]'
  ]);
  expect(result.invalid).toBe(0);
});

const corpus = [
  "https://raider.io/characters/eu/example/aria",
  "https://www.warcraftlogs.com/character/eu/example/aria",
  "https://www.warcraftlogs.com/character/id/42",
  "HTTPS://RAIDER.IO/characters/EU/Example/Aria",
  "https://raider.io/characters/eu/aggra-portugu%C3%AAs/Aria",
  "https://www.warcraftlogs.com/character/eu/pozzo-delleternit%C3%A0/aria",
  "https://raider.io/characters/eu/%D0%B3%D0%BE%D1%80/aria",
  "https://raider.io/characters/xx/example/aria",
  "https://raider.io/characters/eu/example/ariahttps://raider.io/characters/eu/example/bela",
  "https://www.warcraftlogs.com/reports/abc",
  "https://example.com/characters/eu/example/aria"
];

/**
 * What each parser version made of the corpus. A change here changes what the
 * watcher counts, and a rising count is an alert: add a new version rather
 * than editing the current one, so the watcher re-baselines on deploy.
 */
const outcomesByVersion: Record<number, string[]> = {
  1: [
    'character:["eu","example","aria"]',
    'character:["eu","example","aria"]',
    "warcraftlogs_id:42",
    'character:["eu","example","aria"]',
    "invalid",
    "invalid",
    "invalid",
    "invalid",
    "invalid",
    "ignored",
    "ignored"
  ],
  2: [
    'character:["eu","example","aria"]',
    'character:["eu","example","aria"]',
    "warcraftlogs_id:42",
    'character:["eu","example","aria"]',
    'character:["eu","aggra-portugues","aria"]',
    'character:["eu","pozzo-delleternita","aria"]',
    "invalid",
    "invalid",
    "invalid",
    "ignored",
    "ignored"
  ]
};

it("changes what it accepts only under a new parser version", () => {
  const outcomes = corpus.map((cell) => {
    const result = parseApplicantCandidates(cell);
    return (
      result.candidates[0]?.identity ??
      (result.invalid > 0 ? "invalid" : "ignored")
    );
  });
  expect(outcomes).toEqual(outcomesByVersion[applicantParserVersion]);
});
