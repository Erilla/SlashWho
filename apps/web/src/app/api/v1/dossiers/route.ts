import {
  botCreateDossierRequestSchema,
  botCreateDossierResponseSchema
} from "@slashwho/contracts";

import { requireBot } from "../../../../server/bot-auth";
import { loadWebConfig } from "../../../../server/config";
import { getContainer } from "../../../../server/container";
import {
  apiError,
  jsonNoStore,
  withHttpRequest
} from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("bot_dossier_create", async (scope, correlationId) => {
    const authorization = requireBot(
      request.headers,
      loadWebConfig().application
    );
    if ("refusal" in authorization) return authorization.refusal;
    const body = botCreateDossierRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return apiError("invalid_character_url");
    const { botDossiers } = await getContainer();
    const result = await botDossiers.create(
      {
        characters: body.data.characters,
        headers: request.headers,
        correlationId
      },
      scope
    );
    switch (result.kind) {
      case "created":
        return jsonNoStore(botCreateDossierResponseSchema, result.body, {
          status: result.status
        });
      case "rate_limited":
        return jsonNoStore(
          botCreateDossierResponseSchema,
          {
            root: result.root,
            state: "collecting" as const,
            snapshotId: null,
            lastCollectedAt: null,
            evidenceRunIds: [],
            outcomes: result.outcomes,
            retryAfterSeconds: result.retryAfterSeconds
          },
          {
            status: 429,
            headers: { "retry-after": String(result.retryAfterSeconds) }
          }
        );
      case "invalid":
      case "not_found":
      case "suppressed":
      case "failed":
        return apiError(result.code);
    }
  });
}
