import { warcraftLogsCharacterResolutionSchema } from "@slashwho/contracts";

import { loadWebConfig } from "../../../../../server/config";
import { getContainer } from "../../../../../server/container";
import { resolveCredentialOverrides } from "../../../../../server/credential-headers";
import {
  apiError,
  publicReadAuthorizationResponse,
  withHttpRequest
} from "../../../../../server/http";

type CharacterIdParams = { characterId: string };

function parseCharacterId(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * Resolves a pasted Warcraft Logs character-ID URL to the character's current
 * name, realm and region. It spends one Warcraft Logs request, so it is
 * throttled as a public read before anything is asked upstream.
 */
export async function GET(
  request: Request,
  context: { params: Promise<CharacterIdParams> }
): Promise<Response> {
  return withHttpRequest("warcraft_logs_character", async () => {
    const characterId = parseCharacterId((await context.params).characterId);
    if (characterId === undefined) return apiError("invalid_character_url");
    const { characterIds, searches, accountAuth, accountCredentials } =
      await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers)
    );
    if (denied) return denied;
    const { principal } = accountAuth
      ? await accountAuth.authenticate(request)
      : { principal: null };
    const { wclCredentials } = await resolveCredentialOverrides(
      request,
      principal,
      accountCredentials,
      loadWebConfig()
    );
    const result = await characterIds.resolve(
      characterId,
      wclCredentials ?? undefined,
      request.signal
    );
    if (result.kind === "not_found") return apiError("character_not_found");
    if (result.kind === "unavailable") return apiError("upstream_unavailable");
    return Response.json(
      warcraftLogsCharacterResolutionSchema.parse(result.character),
      { headers: { "cache-control": "no-store" } }
    );
  });
}
