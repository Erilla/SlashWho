import { dossierRefreshResponseSchema } from "@slashwho/contracts";

import { requireBot } from "../../../../../../../../server/bot-auth";
import { loadWebConfig } from "../../../../../../../../server/config";
import { getContainer } from "../../../../../../../../server/container";
import {
  apiError,
  jsonNoStore,
  resolveCharacterRoute,
  withHttpRequest
} from "../../../../../../../../server/http";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/dossiers/[region]/[realm]/[name]/refresh">
): Promise<Response> {
  return withHttpRequest("bot_dossier_refresh", async (scope) => {
    const authorization = requireBot(
      request.headers,
      loadWebConfig().application
    );
    if ("refusal" in authorization) return authorization.refusal;
    const character = await resolveCharacterRoute(context, {
      requireCanonical: true
    });
    if ("refusal" in character) return character.refusal;
    const { botDossiers } = await getContainer();
    const result = await botDossiers.refresh(
      character.key,
      { headers: request.headers },
      scope
    );
    if (result.kind === "not_found") return apiError("character_not_found");
    if (result.kind === "rate_limited") {
      return apiError("rate_limited", {
        retryAfterSeconds: result.retryAfterSeconds
      });
    }
    return jsonNoStore(dossierRefreshResponseSchema, {
      mode: result.mode,
      lastCollectedAt: result.lastCollectedAt?.toISOString() ?? null
    });
  });
}
