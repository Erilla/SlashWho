import {
  createDossierRequestSchema,
  dossierStartResponseSchema
} from "@slashwho/contracts";

import { getContainer } from "../../../server/container";
import {
  apiError,
  jsonNoStore,
  startResultResponse,
  withHttpRequest
} from "../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("dossier_start", async (scope, correlationId) => {
    const body = createDossierRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return apiError("invalid_character_url");
    const { dossiers } = await getContainer();
    const result = await dossiers.start(
      {
        characterUrl: body.data.characterUrl,
        headers: request.headers,
        correlationId
      },
      scope
    );
    if ("joinedExistingRun" in result && result.joinedExistingRun) {
      scope.mark("runJoined");
    }
    if (result.kind === "character") {
      return jsonNoStore(dossierStartResponseSchema, { kind: "ready" });
    }
    return startResultResponse(result);
  });
}
