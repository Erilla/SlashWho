import {
  parseApplicantCharacterUrl,
  parseWarcraftLogsCharacterIdUrl,
  type CharacterKey
} from "@slashwho/domain";
import { characterIdentity, numericIdentity } from "./applicant-identity";

export type ApplicantCandidate =
  | { identity: string; kind: "character"; key: CharacterKey }
  | { identity: string; kind: "warcraftlogs_id"; id: number };

export type CandidateParse = {
  candidates: ApplicantCandidate[];
  invalid: number;
  truncated: boolean;
};

const maxCellLength = 4096;
const urlPattern = /https:\/\/[^\s<>"'`]+/gi;

/** Only literal, recognized HTTPS character links leave this parser. */
export function parseApplicantCandidates(value: unknown): CandidateParse {
  if (typeof value !== "string")
    return { candidates: [], invalid: 0, truncated: false };
  const truncated = value.length > maxCellLength;
  const text = value.slice(0, maxCellLength);
  const candidates: ApplicantCandidate[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const match of text.matchAll(urlPattern)) {
    const literal = match[0].replace(/[),.;!?\]}]+$/g, "");
    let url: URL;
    try {
      url = new URL(literal);
    } catch {
      invalid += 1;
      continue;
    }
    if (!["raider.io", "www.warcraftlogs.com"].includes(url.hostname)) continue;
    url.search = "";
    url.hash = "";
    const clean = url.toString().replace(/\/$/, "");
    const id = parseWarcraftLogsCharacterIdUrl(clean);
    if (id !== undefined) {
      const identity = numericIdentity(id);
      if (!seen.has(identity))
        candidates.push({ identity, kind: "warcraftlogs_id", id });
      seen.add(identity);
      continue;
    }
    try {
      const key = parseApplicantCharacterUrl(clean);
      const identity = characterIdentity(key);
      if (!seen.has(identity))
        candidates.push({ identity, kind: "character", key });
      seen.add(identity);
    } catch {
      // Report links and other WCL paths are unrelated, not malformed applicants.
      if (/^\/characters?\//.test(url.pathname)) invalid += 1;
    }
  }
  return { candidates, invalid, truncated };
}
