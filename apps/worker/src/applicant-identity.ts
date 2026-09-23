import { canonicalCharacterId, type CharacterKey } from "@slashwho/domain";

export type ApplicantIdentity =
  | { kind: "character"; key: CharacterKey }
  | { kind: "warcraftlogs_id"; id: number };

export function characterIdentity(key: CharacterKey): string {
  return `character:${canonicalCharacterId(key)}`;
}

export function numericIdentity(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("applicant_identity_invalid");
  return `warcraftlogs_id:${id}`;
}

export function decodeApplicantIdentity(value: string): ApplicantIdentity {
  if (value.startsWith("warcraftlogs_id:")) {
    const text = value.slice("warcraftlogs_id:".length);
    if (!/^[1-9][0-9]*$/.test(text))
      throw new Error("applicant_identity_invalid");
    const id = Number(text);
    if (!Number.isSafeInteger(id))
      throw new Error("applicant_identity_invalid");
    return { kind: "warcraftlogs_id", id };
  }
  if (value.startsWith("character:")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.slice("character:".length));
    } catch {
      throw new Error("applicant_identity_invalid");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      !["us", "eu", "kr", "tw"].includes(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      !/^[a-z0-9-]+$/.test(parsed[1]) ||
      typeof parsed[2] !== "string" ||
      !/^[\p{L}\p{M}'-]+$/u.test(parsed[2])
    ) {
      throw new Error("applicant_identity_invalid");
    }
    return {
      kind: "character",
      key: {
        region: parsed[0] as CharacterKey["region"],
        realm: parsed[1],
        name: parsed[2]
      }
    };
  }
  throw new Error("applicant_identity_invalid");
}
