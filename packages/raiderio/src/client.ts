import type { CharacterKey } from "@slashwho/domain";
import { supportedRegions } from "@slashwho/domain";

import {
  createRaiderIoError,
  isRaiderIoFailure,
  type RaiderIoFailure
} from "./errors";
import {
  normalizeCharacterResponse,
  normalizeProfileResponse
} from "./normalize";
import type {
  RaiderIoCharacter,
  RaiderIoGateway,
  RaiderIoProfile
} from "./types";

export type CreateRaiderIoClientOptions = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  timeoutMs: number;
};

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) return Number(value) * 1000;

  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function responseFailure(response: Response): RaiderIoFailure {
  if (response.status === 404) return { kind: "not_found" };

  const retryAfter = retryAfterMs(response);
  return {
    kind: "transient",
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
  };
}

function validatedCharacterKey(key: CharacterKey): CharacterKey {
  const valid =
    supportedRegions.includes(key.region) &&
    /^[a-z0-9-]+$/.test(key.realm) &&
    /^[\p{L}\p{M}'-]+$/u.test(key.name) &&
    key.realm === key.realm.toLocaleLowerCase("en-US") &&
    key.name === key.name.toLocaleLowerCase("en-US");

  if (!valid) throw new Error("invalid_character_key");
  return key;
}

export function createRaiderIoClient(
  options: CreateRaiderIoClientOptions
): RaiderIoGateway {
  const baseUrl = new URL(options.baseUrl);
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("invalid_base_url");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("invalid_timeout");
  }

  async function request<T>(
    url: URL,
    normalize: (value: unknown) => T
  ): Promise<T> {
    let response: Response;
    try {
      response = await options.fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs)
      });
    } catch (error) {
      if (isRaiderIoFailure(error)) throw error;
      throw createRaiderIoError({ kind: "transient" });
    }

    if (!response.ok) throw createRaiderIoError(responseFailure(response));

    let value: unknown;
    try {
      value = await response.json();
      return normalize(value);
    } catch {
      throw createRaiderIoError({ kind: "schema_drift" });
    }
  }

  function profileUrl(value: string): URL {
    const url = new URL("/api/user/view-characters", baseUrl);
    url.searchParams.set("name", value);
    return url;
  }

  async function getCharacter(key: CharacterKey): Promise<RaiderIoCharacter> {
    const validKey = validatedCharacterKey(key);
    const path = [
      "api",
      "characters",
      validKey.region,
      validKey.realm,
      validKey.name
    ]
      .map(encodeURIComponent)
      .join("/");

    return request(new URL(`/${path}`, baseUrl), normalizeCharacterResponse);
  }

  async function getClaimedCharacters(
    ownerId: string
  ): Promise<readonly RaiderIoCharacter[]> {
    const profile = await request(
      profileUrl(ownerId),
      normalizeProfileResponse
    );
    if (
      profile.validationName.toLocaleLowerCase("en-US") !==
      ownerId.toLocaleLowerCase("en-US")
    ) {
      throw createRaiderIoError({ kind: "schema_drift" });
    }
    return profile.characters;
  }

  async function resolveProfileGuess(
    value: string
  ): Promise<RaiderIoProfile | null> {
    try {
      const profile = await request(
        profileUrl(value),
        normalizeProfileResponse
      );
      if (
        profile.validationName.toLocaleLowerCase("en-US") !==
        value.toLocaleLowerCase("en-US")
      ) {
        return null;
      }
      return { characters: profile.characters };
    } catch (error) {
      if (isRaiderIoFailure(error) && error.kind === "not_found") return null;
      throw error;
    }
  }

  return { getCharacter, getClaimedCharacters, resolveProfileGuess };
}
