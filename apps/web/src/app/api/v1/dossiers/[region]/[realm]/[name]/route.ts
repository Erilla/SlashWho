import { botDossierSummarySchema } from "@slashwho/contracts";
import { botDossierSummaryOf } from "@slashwho/application";

import { requireBot } from "../../../../../../../server/bot-auth";
import { loadWebConfig } from "../../../../../../../server/config";
import { getContainer } from "../../../../../../../server/container";
import {
  apiError,
  etagOf,
  ifNoneMatch,
  jsonNoStore,
  notModified,
  publicReadAuthorizationResponse,
  resolveCharacterRoute,
  withHttpRequest
} from "../../../../../../../server/http";

export async function GET(
  request: Request,
  context: RouteContext<"/api/v1/dossiers/[region]/[realm]/[name]">
): Promise<Response> {
  return withHttpRequest("bot_dossier_summary", async (scope) => {
    const authorization = requireBot(
      request.headers,
      loadWebConfig().application
    );
    if ("refusal" in authorization) return authorization.refusal;
    const character = await resolveCharacterRoute(context, {
      requireCanonical: true
    });
    if ("refusal" in character) return character.refusal;
    const { botDossiers, searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers, scope)
    );
    if (denied) return denied;
    const summary = botDossierSummaryOf(
      await botDossiers.summary(character.key, scope)
    );
    if (!summary) return apiError("character_not_found");
    const etag = etagOf(summary);
    if (ifNoneMatch(request, etag)) return notModified(etag);
    return jsonNoStore(botDossierSummarySchema, summary, {
      headers: { etag }
    });
  });
}
