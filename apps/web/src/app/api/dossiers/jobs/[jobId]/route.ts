import { dossierResearchStatusSchema } from "@slashwho/contracts";

import { getContainer } from "../../../../../server/container";
import {
  apiError,
  jsonNoStore,
  publicReadAuthorizationResponse,
  withHttpRequest
} from "../../../../../server/http";

export async function GET(
  request: Request,
  context: RouteContext<"/api/dossiers/jobs/[jobId]">
): Promise<Response> {
  return withHttpRequest("dossier_research_status", async (scope) => {
    const { jobId } = await context.params;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        jobId
      )
    ) {
      return apiError("character_not_found");
    }
    const { searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers, scope)
    );
    if (denied) return denied;
    const run = await searches.getRun(jobId);
    if (!run) return apiError("character_not_found");
    return jsonNoStore(dossierResearchStatusSchema, {
      status: run.status,
      error: run.error
    });
  });
}
