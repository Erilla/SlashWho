import { applicantDossierSchema } from "@slashwho/contracts";

import { loadWebConfig } from "../../../../../../server/config";
import { readCredentialOverrides } from "../../../../../../server/credential-headers";
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
      const initialScope =
        new URL(request.url).searchParams.get("scope") === "initial";
      return new Response(null, {
        status: 308,
        headers: {
          "cache-control": "no-store",
          location: `/api/dossiers/${parsed.key.region}/${parsed.key.realm}/${parsed.key.name}${initialScope ? "?scope=initial" : ""}`
        }
      });
    }
    const { dossiers, searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers)
    );
    if (denied) return denied;
    const overrides = readCredentialOverrides(request.headers, loadWebConfig());
    const result =
      new URL(request.url).searchParams.get("scope") === "initial"
        ? await dossiers.readInitial(parsed.key, request.signal, overrides)
        : await dossiers.read(parsed.key, request.signal, overrides);
    if (result.kind === "not_ready") return apiError("discovery_not_ready");
    return Response.json(applicantDossierSchema.parse(result.dossier), {
      headers: { "cache-control": "no-store" }
    });
  });
}
