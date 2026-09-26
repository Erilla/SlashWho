import { dossierTierSearchResponse } from "@slashwho/application";
import {
  dossierTierSearchResponseSchema,
  type DossierTierSearchResponse
} from "@slashwho/contracts";

import { getContainer } from "../../../../../../../../../server/container";
import { loadWebConfig } from "../../../../../../../../../server/config";
import { resolveCredentialOverrides } from "../../../../../../../../../server/credential-headers";
import {
  apiError,
  parseCharacterRoute,
  publicReadAuthorizationResponse,
  withHttpRequest
} from "../../../../../../../../../server/http";

type TierParams = {
  region: string;
  realm: string;
  name: string;
  raidId: string;
};

function respond(body: DossierTierSearchResponse, status = 200): Response {
  return Response.json(dossierTierSearchResponseSchema.parse(body), {
    status,
    headers: { "cache-control": "no-store" }
  });
}

/**
 * Queues one explicit search of a tier (#435) for every included character of
 * the dossier (#449). Open to any visitor, like refresh, and limited twice:
 * per caller here, and per tier and character where each search is reserved.
 * It never searches more than the one tier it names.
 */
export async function POST(
  request: Request,
  context: { params: Promise<TierParams> }
): Promise<Response> {
  return withHttpRequest("dossier_tier_search", async (scope) => {
    const params = await context.params;
    let character: ReturnType<typeof parseCharacterRoute>;
    try {
      character = parseCharacterRoute(params);
    } catch {
      return apiError("invalid_character_url");
    }
    if (!character.canonical) return apiError("invalid_character_url");
    let raidId: string;
    try {
      raidId = decodeURIComponent(params.raidId);
    } catch {
      return apiError("tier_not_found");
    }
    if (!/^[A-Za-z0-9-]{1,64}$/.test(raidId)) {
      return apiError("tier_not_found");
    }
    const { dossiers, searches, accountAuth, accountCredentials } =
      await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizeTierSearch(request.headers, scope)
    );
    if (denied) return denied;
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
    const result = await dossiers.searchTier(
      character.key,
      raidId,
      scope,
      overrides
    );
    if (result.kind === "unknown_tier") return apiError("tier_not_found");
    // Accepted when any character's search was queued now. A press that
    // queued none is refused only when nothing is in flight or searched to
    // show for it: every character busy, or with nothing to add to. One whose
    // only attempts failed says so, with each character's outcome.
    const { reserved, body } = dossierTierSearchResponse(result.characters);
    return respond(
      body,
      reserved
        ? 202
        : body.state === "failed"
          ? 503
          : body.state === "busy" || body.state === "no_evidence"
            ? 409
            : 200
    );
  });
}
