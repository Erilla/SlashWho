import {
  evidenceRunProgressMaxIds,
  evidenceRunProgressResponseSchema
} from "@slashwho/contracts";

import { getContainer } from "../../../../server/container";
import {
  apiError,
  jsonNoStore,
  publicReadAuthorizationResponse,
  withHttpRequest
} from "../../../../server/http";

const runIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The ids a request watches, or null when any of them is malformed. The ids
 * come from `evidenceRunIds` on a dossier the caller has already read.
 */
function watchedRunIds(request: Request): string[] | null {
  const ids = [
    ...new Set(
      (new URL(request.url).searchParams.get("ids") ?? "")
        .split(",")
        .filter((id) => id !== "")
        .map((id) => id.toLowerCase())
    )
  ];
  if (ids.length === 0 || ids.length > evidenceRunProgressMaxIds) return null;
  return ids.every((id) => runIdPattern.test(id)) ? ids : null;
}

/**
 * Where a dossier's evidence runs have got to (#690). A page watching its
 * collection asks this, not the dossier: one query, with no reservation and
 * no provider call, so it can ask often enough to notice a publish promptly.
 */
export async function GET(request: Request): Promise<Response> {
  return withHttpRequest("dossier_evidence_runs", async (scope) => {
    const ids = watchedRunIds(request);
    if (!ids) return apiError("character_not_found");
    const { searches, dossiers } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers, scope)
    );
    if (denied) return denied;
    return jsonNoStore(evidenceRunProgressResponseSchema, {
      runs: await dossiers.readEvidenceRunProgress(ids, scope)
    });
  });
}
