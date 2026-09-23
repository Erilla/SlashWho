import type { WarcraftLogsCharacterResolution } from "@slashwho/contracts";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";

import type { WarcraftLogsCredentials } from "./config";

export type CharacterIdResolution =
  | { kind: "character"; character: WarcraftLogsCharacterResolution }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export type CharacterIdResolver = Readonly<{
  resolve(
    characterId: number,
    visitorCredentials?: Readonly<{ clientId: string; clientSecret: string }>,
    signal?: AbortSignal
  ): Promise<CharacterIdResolution>;
}>;

type CharacterIdGateway = Pick<WarcraftLogsGateway, "resolveCharacterById">;

/**
 * Resolves a pasted Warcraft Logs character-ID URL to the character's current
 * name, realm and region, so the rest of the pipeline can stay name-keyed.
 *
 * A visitor's own credentials are preferred, as for every other provider, so
 * their pastes spend their allowance rather than the server's. The server's
 * gateway is built once: it caches its OAuth token, and a paste should cost a
 * single GraphQL request.
 */
export function createCharacterIdResolver(
  options: Readonly<{
    credentials?: WarcraftLogsCredentials;
    createGateway(credentials: WarcraftLogsCredentials): CharacterIdGateway;
  }>
): CharacterIdResolver {
  let shared: CharacterIdGateway | undefined;

  function gatewayFor(
    visitor: Readonly<{ clientId: string; clientSecret: string }> | undefined
  ): CharacterIdGateway | undefined {
    const baseUrl = options.credentials?.baseUrl;
    if (visitor) {
      return options.createGateway({
        clientId: visitor.clientId,
        clientSecret: visitor.clientSecret,
        ...(baseUrl ? { baseUrl } : {})
      });
    }
    if (!options.credentials) return undefined;
    shared ??= options.createGateway(options.credentials);
    return shared;
  }

  return {
    async resolve(characterId, visitorCredentials, signal) {
      const gateway = gatewayFor(visitorCredentials);
      if (!gateway) return { kind: "unavailable" };
      const result = await gateway.resolveCharacterById(characterId, signal);
      if (result.kind === "identity") {
        return {
          kind: "character",
          character: {
            characterId: result.characterId,
            region: result.key.region,
            realm: result.key.realm,
            name: result.displayName
          }
        };
      }
      // A private profile is indistinguishable from an absent one to the
      // visitor: neither can be researched.
      return result.code === "not_found" || result.code === "private"
        ? { kind: "not_found" }
        : { kind: "unavailable" };
    }
  };
}
