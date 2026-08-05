import type { CharacterKey, Region } from "@slashwho/domain";
import { supportedRegions } from "@slashwho/domain";
import { z } from "zod";

import type { RaiderIoCharacter } from "./types";

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
};

function normalizedRegion(value: string): Region {
  const region = value.toLocaleLowerCase("en-US");
  if (!supportedRegions.includes(region as Region)) {
    throw new Error("unsupported_region");
  }
  return region as Region;
}

function normalizedSlug(value: string): string {
  const slug = value.toLocaleLowerCase("en-US");
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("invalid_realm");
  return slug;
}

function normalizedName(value: string): string {
  const name = value.toLocaleLowerCase("en-US");
  if (!/^[\p{L}\p{M}'-]+$/u.test(name)) throw new Error("invalid_name");
  return name;
}

function characterKey(
  region: string,
  realm: string,
  name: string
): CharacterKey {
  return {
    region: normalizedRegion(region),
    realm: normalizedSlug(realm),
    name: normalizedName(name)
  };
}

function normalizedCharacter(character: UpstreamCharacter): RaiderIoCharacter {
  return {
    key: characterKey(
      character.region.slug,
      character.realm.slug,
      character.name
    ),
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
): CharacterKey {
  const match = main.path?.match(
    /^\/characters\/([^/]+)\/([^/]+)\/([^/?#]+)\/?$/i
  );
  const region = main.region?.slug ?? match?.[1];
  const realm = main.realm?.slug ?? match?.[2];

  if (!region || !realm) throw new Error("invalid_declared_main");
  return characterKey(region, realm, main.name);
}

export function normalizeCharacterResponse(value: unknown): RaiderIoCharacter {
  const parsed = characterResponseSchema.parse(value);
  const details = parsed.characterDetails;
  const customizations = details.characterCustomizations;
  const character = normalizedCharacter(details.character);

  return {
    ...character,
    ownerId: details.user?.name ?? null,
    profileGuess: customizations?.discord_profile ?? null,
    declaredMain: customizations?.main_character
      ? declaredMainKey(customizations.main_character)
      : null
  };
}

export function normalizeProfileResponse(
  value: unknown
): NormalizedProfileResponse {
  const parsed = profileResponseSchema.parse(value).viewUserCharactersApi;

  return {
    validationName: parsed.name,
    characters: parsed.characters.map(({ character }) =>
      normalizedCharacter(character)
    )
  };
}
