import {
  connectedCharacterExclusionRequestSchema,
  createDossierRequestSchema,
  dossierStartResponseSchema
} from "@slashwho/contracts";

import { getContainer } from "../../../../../../../server/container";
import {
  apiError,
  jsonNoStore,
  resolveCharacterRoute,
  startResultResponse,
  withHttpRequest
} from "../../../../../../../server/http";

type CharacterContext =
  RouteContext<"/api/dossiers/[region]/[realm]/[name]/connected-characters">;

const changed = () =>
  jsonNoStore(dossierStartResponseSchema, { kind: "ready" });

/** A guard rather than an inline check, which cannot narrow a union `kind`. */
function isLinked(result: {
  kind: string;
}): result is { kind: "linked" | "duplicate" } {
  return result.kind === "linked" || result.kind === "duplicate";
}

export async function POST(
  request: Request,
  context: CharacterContext
): Promise<Response> {
  return withHttpRequest("dossier_connection", async (scope, correlationId) => {
    const root = await resolveCharacterRoute(context, {
      requireCanonical: true
    });
    if ("refusal" in root) return root.refusal;
    const body = createDossierRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return apiError("invalid_character_url");
    const { dossiers } = await getContainer();
    const result = await dossiers.addConnectedCharacter(
      root.key,
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
    if (isLinked(result)) return changed();
    if (result.kind === "character") return apiError("search_failed");
    return startResultResponse(result);
  });
}

export async function PATCH(
  request: Request,
  context: CharacterContext
): Promise<Response> {
  return withHttpRequest("dossier_connection_exclusion", async (scope) => {
    const root = await resolveCharacterRoute(context, {
      requireCanonical: true
    });
    if ("refusal" in root) return root.refusal;
    const body = connectedCharacterExclusionRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return apiError("invalid_character_url");
    const { dossiers } = await getContainer();
    const result = await dossiers.setConnectedCharacterExclusion(
      root.key,
      {
        characterUrl: body.data.characterUrl,
        excluded: body.data.excluded
      },
      scope
    );
    if (result.kind === "updated") return changed();
    if (result.kind === "invalid") return apiError(result.code);
    return apiError("connection_not_found");
  });
}

export async function DELETE(
  request: Request,
  context: CharacterContext
): Promise<Response> {
  return withHttpRequest("dossier_connection_removal", async (scope) => {
    const root = await resolveCharacterRoute(context, {
      requireCanonical: true
    });
    if ("refusal" in root) return root.refusal;
    const body = createDossierRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return apiError("invalid_character_url");
    const { dossiers } = await getContainer();
    const result = await dossiers.removeConnectedCharacter(
      root.key,
      { characterUrl: body.data.characterUrl },
      scope
    );
    if (result.kind === "removed") return changed();
    if (result.kind === "invalid") return apiError(result.code);
    return apiError("connection_not_found");
  });
}
