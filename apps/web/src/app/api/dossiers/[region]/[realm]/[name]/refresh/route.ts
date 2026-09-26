import { dossierRefreshResponseSchema } from "@slashwho/contracts";

import { getContainer } from "../../../../../../../server/container";
import { loadWebConfig } from "../../../../../../../server/config";
import { resolveCredentialOverrides } from "../../../../../../../server/credential-headers";
import {
  apiError,
  parseCharacterRoute,
  withHttpRequest
} from "../../../../../../../server/http";

type CharacterParams = { region: string; realm: string; name: string };

/**
 * Re-collects one character on demand. A press inside the character's cooldown
 * reads only the most recent reports rather than refusing, so the control
 * always does something honest.
 */
export async function POST(
  request: Request,
  context: { params: Promise<CharacterParams> }
): Promise<Response> {
  return withHttpRequest("dossier_refresh", async (scope) => {
    let character: ReturnType<typeof parseCharacterRoute>;
    try {
      character = parseCharacterRoute(await context.params);
    } catch {
      return apiError("invalid_character_url");
    }
    if (!character.canonical) return apiError("invalid_character_url");
    const { dossiers, accountAuth, accountCredentials } = await getContainer();
    const { principal } = accountAuth
      ? await accountAuth.authenticate(request, scope)
      : { principal: null };
    const overrides =
      principal?.kind === "account"
        ? await resolveCredentialOverrides(
            request,
            principal,
            accountCredentials,
            loadWebConfig(),
            scope
          )
        : undefined;
    const result = await dossiers.refreshCharacter(
      character.key,
      scope,
      overrides
    );
    return Response.json(
      dossierRefreshResponseSchema.parse({
        mode: result.mode,
        lastCollectedAt: result.lastCollectedAt?.toISOString() ?? null
      }),
      { headers: { "cache-control": "no-store" } }
    );
  });
}
