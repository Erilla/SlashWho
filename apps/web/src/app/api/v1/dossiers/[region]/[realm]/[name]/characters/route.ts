import {
  botAddDossierCharacterRequestSchema,
  botAddDossierCharacterResponseSchema
} from "@slashwho/contracts";

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
  context: RouteContext<"/api/v1/dossiers/[region]/[realm]/[name]/characters">
): Promise<Response> {
  return withHttpRequest(
    "bot_dossier_character",
    async (scope, correlationId) => {
      const authorization = requireBot(
        request.headers,
        loadWebConfig().application
      );
      if ("refusal" in authorization) return authorization.refusal;
      const root = await resolveCharacterRoute(context, {
        requireCanonical: true
      });
      if ("refusal" in root) return root.refusal;
      const body = botAddDossierCharacterRequestSchema.safeParse(
        await request.json().catch(() => null)
      );
      if (!body.success) return apiError("invalid_character_url");
      const { botDossiers } = await getContainer();
      const result = await botDossiers.addCharacter(
        root.key,
        {
          characterUrl: body.data.characterUrl,
          headers: request.headers,
          correlationId
        },
        scope
      );
      switch (result.kind) {
        case "linked":
          return jsonNoStore(
            botAddDossierCharacterResponseSchema,
            {
              kind: "linked",
              ...(result.jobId === undefined ? {} : { jobId: result.jobId })
            },
            { status: result.jobId === undefined ? 200 : 202 }
          );
        case "rate_limited":
          return apiError("rate_limited", {
            retryAfterSeconds: result.retryAfterSeconds
          });
        case "invalid":
        case "not_found":
        case "suppressed":
        case "failed":
          return apiError(result.code);
      }
    }
  );
}
