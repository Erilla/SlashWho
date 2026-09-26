import { recentDossierSearchesResponseSchema } from "@slashwho/contracts";
import { formatCharacterDisplayName } from "@slashwho/domain";

import { getContainer } from "../../../../server/container";
import {
  jsonNoStore,
  publicReadAuthorizationResponse,
  withHttpRequest
} from "../../../../server/http";

/** How many characters the landing page lists. */
const RECENT_DOSSIER_SEARCH_LIMIT = 10;

export async function GET(request: Request): Promise<Response> {
  return withHttpRequest("dossier_recent_searches", async (scope) => {
    const { dossiers, searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers, scope)
    );
    if (denied) return denied;
    const recent = await dossiers.listRecentSearches(
      RECENT_DOSSIER_SEARCH_LIMIT,
      scope
    );
    return jsonNoStore(recentDossierSearchesResponseSchema, {
      searches: recent.map((search) => ({
        character: search.key,
        // A character discovery has not created yet has only its key.
        displayName: formatCharacterDisplayName(
          search.displayName ?? search.key.name
        ),
        searchedAt: search.searchedAt.toISOString(),
        state: search.inProgress ? "in_progress" : "complete"
      }))
    });
  });
}
