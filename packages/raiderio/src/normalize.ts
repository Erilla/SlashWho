import type { CharacterKey, Region } from "@slashwho/domain";
import { supportedRegions } from "@slashwho/domain";
import { z } from "zod";

import type { RaiderIoCharacter } from "./types";

// The accepted upstream ranges below must stay a subset of the public schemas in
// @slashwho/contracts: anything accepted here can be committed to an immutable
// snapshot, and a value the public schema later rejects makes that snapshot
// permanently unreadable. The two validators stay separate because they guard
// different untrusted inputs, but their ranges are reconciled deliberately.
const upstreamCharacterSchema = z.object({
  name: z.string().min(1),
  level: z.number().int().nonnegative(),
  class: z.object({ name: z.string().min(1) }),
  realm: z.object({ slug: z.string().min(1) }),
  region: z.object({ slug: z.string().min(1) })
});

const declaredMainSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  realm: z.object({ slug: z.string().min(1) }).optional(),
  region: z.object({ slug: z.string().min(1) }).optional()
});

const characterResponseSchema = z.object({
  characterDetails: z.object({
    character: upstreamCharacterSchema,
    user: z
      .object({ name: z.string().min(1) })
      .nullable()
      .optional(),
    characterCustomizations: z
      .object({
        discord_profile: z.string().min(1).nullable().optional(),
        main_character: declaredMainSchema.nullable().optional()
      })
      .optional()
  })
});

const profileResponseSchema = z.object({
  viewUserCharactersApi: z.object({
    name: z.string().min(1),
    characters: z.array(z.object({ character: upstreamCharacterSchema }))
  })
});

type UpstreamCharacter = z.infer<typeof upstreamCharacterSchema>;

export type NormalizedProfileResponse = {
  readonly validationName: string;
  readonly characters: readonly RaiderIoCharacter[];
  readonly omittedMembers: boolean;
};

function normalizedRegion(value: string): Region | null {
  const region = value.toLocaleLowerCase("en-US");
  return supportedRegions.includes(region as Region)
    ? (region as Region)
    : null;
}

function normalizedSlug(value: string): string | null {
  const slug = value.toLocaleLowerCase("en-US");
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

function normalizedName(value: string): string | null {
  const name = value.toLocaleLowerCase("en-US");
  return /^[\p{L}\p{M}'-]+$/u.test(name) ? name : null;
}

/**
 * Returns null when the upstream values fall outside the key space this system
 * can represent (an unsupported region such as `cn`, a realm slug or a character
 * name that cannot be canonicalized). Callers skip such members instead of
 * failing: `schema_drift` is reserved for structural change to the payload.
 */
function characterKey(
  region: string,
  realm: string,
  name: string
): CharacterKey | null {
  const normalizedRegionValue = normalizedRegion(region);
  const normalizedRealm = normalizedSlug(realm);
  const normalizedCharacterName = normalizedName(name);
  if (!normalizedRegionValue || !normalizedRealm || !normalizedCharacterName) {
    return null;
  }
  return {
    region: normalizedRegionValue,
    realm: normalizedRealm,
    name: normalizedCharacterName
  };
}

function normalizedCharacter(
  character: UpstreamCharacter,
  key: CharacterKey
): RaiderIoCharacter {
  return {
    key,
    displayName: character.name,
    className: character.class.name,
    level: character.level,
    ownerId: null,
    profileGuess: null,
    declaredMain: null
  };
}

function declaredMainKey(
  main: z.infer<typeof declaredMainSchema>
): CharacterKey | null {
  const match = main.path?.match(
    /^\/characters\/([^/]+)\/([^/]+)\/([^/?#]+)\/?$/i
  );
  const region = main.region?.slug ?? match?.[1];
  const realm = main.realm?.slug ?? match?.[2];

  if (!region || !realm) return null;
  return characterKey(region, realm, main.name);
}

/**
 * The requested key is authoritative: upstream realm aliases and renames are
 * display data only, so a divergence cannot produce a snapshot whose root row
 * fails to match the key the caller asked for.
 */
export function normalizeCharacterResponse(
  value: unknown,
  requestedKey: CharacterKey
): RaiderIoCharacter {
  const parsed = characterResponseSchema.parse(value);
  const details = parsed.characterDetails;
  const customizations = details.characterCustomizations;
  const character = normalizedCharacter(details.character, requestedKey);
  const declaredMain = customizations?.main_character
    ? declaredMainKey(customizations.main_character)
    : null;
  const omittedMembers = Boolean(
    customizations?.main_character && !declaredMain
  );

  return {
    ...character,
    ownerId: details.user?.name ?? null,
    profileGuess: customizations?.discord_profile ?? null,
    declaredMain,
    ...(omittedMembers ? { omittedMembers: true } : {})
  };
}

export function normalizeProfileResponse(
  value: unknown
): NormalizedProfileResponse {
  const parsed = profileResponseSchema.parse(value).viewUserCharactersApi;
  const characters: RaiderIoCharacter[] = [];
  let omittedMembers = false;

  for (const { character } of parsed.characters) {
    const key = characterKey(
      character.region.slug,
      character.realm.slug,
      character.name
    );
    if (!key) {
      omittedMembers = true;
      continue;
    }
    characters.push(normalizedCharacter(character, key));
  }

  return { validationName: parsed.name, characters, omittedMembers };
}
