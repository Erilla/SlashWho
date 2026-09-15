import {
  createDossierRequestSchema,
  dossierStartResponseSchema
} from "@slashwho/contracts";

import { getContainer } from "../../../server/container";
import { apiError, withHttpRequest } from "../../../server/http";

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
    if (result.kind === "job") {
      return Response.json(
        dossierStartResponseSchema.parse({
          kind: "job",
          jobId: result.jobId,
          status: result.status
        }),
        {
          status: 202,
          headers: {
            "cache-control": "no-store",
            location: `/api/dossiers/jobs/${result.jobId}`
          }
        }
      );
    }
    if (result.kind === "character") {
      return Response.json(
        dossierStartResponseSchema.parse({ kind: "ready" }),
        {
          headers: { "cache-control": "no-store" }
        }
      );
    }
    if (result.kind === "rate_limited") {
      return apiError("rate_limited", {
        retryAfterSeconds: result.retryAfterSeconds
      });
    }
    return apiError(result.code);
  });
}
