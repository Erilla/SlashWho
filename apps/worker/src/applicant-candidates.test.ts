import { expect, it } from "vitest";
import { parseApplicantCandidates } from "./applicant-candidates";

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
