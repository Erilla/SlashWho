import { supportedRegions, type CharacterKey } from "@slashwho/domain";

import type {
  WarcraftLogsIdentityResult,
  WarcraftLogsVerifiedKill
} from "../types";
import {
  nonEmptyString,
  positiveInteger,
  record,
  validCharacterKey
} from "./primitives";

export function canonicalIdentity(value: unknown): WarcraftLogsIdentityResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && characterData.character;
  if (character === null) return { kind: "limitation", code: "not_found" };

  const entry = record(character);
  const server = entry && record(entry.server);
  const region = server && record(server.region);
  const characterId = entry && positiveInteger(entry.id);
  const displayName = entry && nonEmptyString(entry.name);
  const realm = server && nonEmptyString(server.slug);
  const regionSlug = region && nonEmptyString(region.slug);
  if (!characterId || !displayName || !realm || !regionSlug) {
    return { kind: "limitation", code: "schema_drift" };
  }

  const key = {
    region: regionSlug.toLocaleLowerCase("en-US"),
    realm: realm.toLocaleLowerCase("en-US"),
    name: displayName.toLocaleLowerCase("en-US")
  } as CharacterKey;
  try {
    validCharacterKey(key);
  } catch {
    return { kind: "limitation", code: "schema_drift" };
  }
  return { kind: "identity", key, displayName, characterId };
}

/**
 * The guilds Warcraft Logs lists for a character. One it cannot place in a
 * supported region is left out rather than guessed at.
 */
export function characterGuilds(
  value: unknown
): readonly WarcraftLogsVerifiedKill["guild"][] {
  const character = record(
    record(record(value)?.data)?.characterData
  )?.character;
  const guilds = record(character)?.guilds;
  if (!Array.isArray(guilds)) return [];
  return guilds.flatMap((value) => {
    const guild = record(value);
    const server = guild && record(guild.server);
    const name = guild && nonEmptyString(guild.name);
    const realm = server && nonEmptyString(server.slug);
    const region = nonEmptyString(
      record(server?.region)?.slug
    )?.toLocaleLowerCase("en-US");
    if (
      !name ||
      !realm ||
      !region ||
      !supportedRegions.includes(region as CharacterKey["region"])
    ) {
      return [];
    }
    return [{ name, realm, region: region as CharacterKey["region"] }];
  });
}
