import { applicantDossierSchema } from "@slashwho/contracts";

import { getContainer } from "../../../../../../server/container";
import {
  apiError,
  parseCharacterRoute,
  publicReadAuthorizationResponse,
  withHttpRequest
} from "../../../../../../server/http";

type CharacterParams = { region: string; realm: string; name: string };

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
    const result =
      new URL(request.url).searchParams.get("scope") === "initial"
        ? await dossiers.readInitial(parsed.key, request.signal)
        : await dossiers.read(parsed.key, request.signal);
    if (result.kind === "not_ready") return apiError("discovery_not_ready");
    return Response.json(applicantDossierSchema.parse(result.dossier), {
      headers: { "cache-control": "no-store" }
    });
  });
}
