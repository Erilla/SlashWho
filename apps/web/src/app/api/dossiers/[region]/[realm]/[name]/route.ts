import { applicantDossierSchema } from "@slashwho/contracts";

import { getContainer } from "../../../../../../server/container";
import {
  apiError,
  parseCharacterRoute,
  publicReadAuthorizationResponse,
  withHttpRequest
} from "../../../../../../server/http";

type CharacterParams = { region: string; realm: string; name: string };

function discoveryNotReadyResponse(): Response {
  return Response.json(
    {
      error: {
        code: "discovery_not_ready",
        message: "Discovery is still in progress."
      }
    },
    { status: 409, headers: { "cache-control": "no-store" } }
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<CharacterParams> }
): Promise<Response> {
  return withHttpRequest("dossier", async () => {
    let parsed: ReturnType<typeof parseCharacterRoute>;
    try {
      parsed = parseCharacterRoute(await context.params);
    } catch {
      return apiError("invalid_character_url");
    }
    if (!parsed.canonical) {
      return new Response(null, {
        status: 308,
        headers: {
          "cache-control": "no-store",
          location: `/api/dossiers/${parsed.key.region}/${parsed.key.realm}/${parsed.key.name}`
        }
      });
    }
    const { dossiers, searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers)
    );
    if (denied) return denied;
    const result = await dossiers.read(parsed.key, request.signal);
    if (result.kind === "not_ready") return discoveryNotReadyResponse();
    return Response.json(applicantDossierSchema.parse(result.dossier), {
      headers: { "cache-control": "no-store" }
    });
  });
}
