import { dossierRefreshResponseSchema } from "@slashwho/contracts";

import { getContainer } from "../../../../../../../server/container";
import { loadWebConfig } from "../../../../../../../server/config";
import { resolveCredentialOverrides } from "../../../../../../../server/credential-headers";
import {
  jsonNoStore,
  resolveCharacterRoute,
  withHttpRequest
} from "../../../../../../../server/http";

/**
 * Re-collects one character on demand. A press inside the character's cooldown
 * reads only the most recent reports rather than refusing, so the control
 * always does something honest.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/dossiers/[region]/[realm]/[name]/refresh">
): Promise<Response> {
  return withHttpRequest("dossier_refresh", async (scope) => {
    const character = await resolveCharacterRoute(context, {
      requireCanonical: true
    });
    if ("refusal" in character) return character.refusal;
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
    return jsonNoStore(dossierRefreshResponseSchema, {
      mode: result.mode,
      lastCollectedAt: result.lastCollectedAt?.toISOString() ?? null
    });
  });
}
