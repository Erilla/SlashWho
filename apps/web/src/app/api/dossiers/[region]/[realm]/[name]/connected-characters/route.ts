import {
  createDossierRequestSchema,
  dossierStartResponseSchema
} from "@slashwho/contracts";

import { getContainer } from "../../../../../../../server/container";
import {
  apiError,
  parseCharacterRoute,
  withHttpRequest
} from "../../../../../../../server/http";

type CharacterParams = { region: string; realm: string; name: string };

export async function POST(
  request: Request,
  context: { params: Promise<CharacterParams> }
): Promise<Response> {
  return withHttpRequest("dossier_connection", async () => {
    let root: ReturnType<typeof parseCharacterRoute>;
    try {
      root = parseCharacterRoute(await context.params);
    } catch {
      return apiError("invalid_character_url");
    }
    if (!root.canonical) return apiError("invalid_character_url");
    const body = createDossierRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return apiError("invalid_character_url");
    const { dossiers } = await getContainer();
    const result = await dossiers.addConnectedCharacter(root.key, {
      characterUrl: body.data.characterUrl,
      headers: request.headers
    });
    if (result.kind === "linked" || result.kind === "duplicate") {
      return Response.json(
        dossierStartResponseSchema.parse({ kind: "ready" }),
        {
          headers: { "cache-control": "no-store" }
        }
      );
    }
    if (result.kind === "job") {
      return Response.json(
        dossierStartResponseSchema.parse({
          kind: "job",
          jobId: result.jobId,
          status: result.status
        }),
        { status: 202, headers: { "cache-control": "no-store" } }
      );
    }
    if (result.kind === "character") return apiError("search_failed");
    if (result.kind === "rate_limited")
      return apiError("rate_limited", {
        retryAfterSeconds: result.retryAfterSeconds
      });
    return apiError("code" in result ? result.code : "search_failed");
  });
}
