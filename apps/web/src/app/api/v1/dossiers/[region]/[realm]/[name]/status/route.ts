import { botDossierStatusSchema } from "@slashwho/contracts";
import { botDossierStatusOf } from "@slashwho/application";

import { requireBot } from "../../../../../../../../server/bot-auth";
import { loadWebConfig } from "../../../../../../../../server/config";
import { getContainer } from "../../../../../../../../server/container";
import {
  apiError,
  etagOf,
  ifNoneMatch,
  jsonNoStore,
  notModified,
  publicReadAuthorizationResponse,
  resolveCharacterRoute,
  withHttpRequest
} from "../../../../../../../../server/http";

export async function GET(
  request: Request,
  context: RouteContext<"/api/v1/dossiers/[region]/[realm]/[name]/status">
): Promise<Response> {
  return withHttpRequest("bot_dossier_status", async (scope) => {
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
    // Existence first: an unknown or suppressed key is a 404 even when the
    // read bucket is exhausted, and a retry costs no read token.
    const read = await botDossiers.status(character.key, scope);
    if (read.kind === "not_found") return apiError("character_not_found");
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers, scope)
    );
    if (denied) return denied;
    const status = botDossierStatusOf(read);
    if (!status) return apiError("character_not_found");
    const etag = etagOf(status);
    if (ifNoneMatch(request, etag)) return notModified(etag);
    return jsonNoStore(botDossierStatusSchema, { ...status, etag });
  });
}
