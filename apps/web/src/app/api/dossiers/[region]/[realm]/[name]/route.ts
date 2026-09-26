import { applicantDossierSchema } from "@slashwho/contracts";

import { compactDossierWipes } from "../../../../../../lib/dossier-wipes";
import { loadWebConfig } from "../../../../../../server/config";
import { resolveCredentialOverrides } from "../../../../../../server/credential-headers";
import { getContainer } from "../../../../../../server/container";
import {
  apiError,
  jsonNoStore,
  publicReadAuthorizationResponse,
  resolveCharacterRoute,
  withHttpRequest
} from "../../../../../../server/http";

export async function GET(
  request: Request,
  context: RouteContext<"/api/dossiers/[region]/[realm]/[name]">
): Promise<Response> {
  return withHttpRequest("dossier", async (scope) => {
    // A non-canonical spelling redirects rather than being refused.
    const parsed = await resolveCharacterRoute(context, {
      requireCanonical: false
    });
    if ("refusal" in parsed) return parsed.refusal;
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
    const { dossiers, searches, accountAuth, accountCredentials } =
      await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers, scope)
    );
    if (denied) return denied;
    const { principal } = accountAuth
      ? await accountAuth.authenticate(request, scope)
      : { principal: null };
    const overrides = await resolveCredentialOverrides(
      request,
      principal,
      accountCredentials,
      loadWebConfig(),
      scope
    );
    const result =
      new URL(request.url).searchParams.get("scope") === "initial"
        ? await dossiers.readInitial(
            parsed.key,
            request.signal,
            overrides,
            scope
          )
        : await dossiers.read(parsed.key, request.signal, overrides, scope);
    if (result.kind === "not_ready") return apiError("discovery_not_ready");
    return jsonNoStore(
      applicantDossierSchema,
      compactDossierWipes(result.dossier)
    );
  });
}
