import {
  dossierTierSearchResponseSchema,
  type DossierTierSearchResponse
} from "@slashwho/contracts";

import { getContainer } from "../../../../../../../../../server/container";
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
 * Queues one explicit search of the character's tier (#435). Open to any
 * visitor, like refresh, and limited twice: per caller here, and per tier and
 * character where the search is reserved. It never searches more than the
 * one tier it names.
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
    const { dossiers, searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizeTierSearch(request.headers)
    );
    if (denied) return denied;
    const result = await dossiers.searchTier(character.key, raidId, scope);
    switch (result.kind) {
      case "unknown_tier":
        return apiError("tier_not_found");
      case "queued":
        return respond({ state: "queued", searchableAgainAt: null }, 202);
      case "busy":
        // This very search, in flight: say where it is. Anything else in
        // flight means nothing was reserved.
        return result.searchingThisTier
          ? respond({
              state: result.status === "running" ? "running" : "queued",
              searchableAgainAt: null
            })
          : respond({ state: "busy", searchableAgainAt: null }, 409);
      case "recent":
        return respond({
          state: "searched",
          searchableAgainAt: result.searchableAgainAt.toISOString()
        });
      case "no_evidence":
        return respond({ state: "no_evidence", searchableAgainAt: null }, 409);
    }
  });
}
