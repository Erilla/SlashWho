import {
  connectedCharacterExclusionRequestSchema,
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
  return withHttpRequest("dossier_connection", async (scope, correlationId) => {
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

/** The dossier the link belongs to, or the refusal that stops the request. */
async function resolveRoot(context: {
  params: Promise<CharacterParams>;
}): Promise<
  { key: ReturnType<typeof parseCharacterRoute>["key"] } | { refusal: Response }
> {
  try {
    const root = parseCharacterRoute(await context.params);
    if (!root.canonical) return { refusal: apiError("invalid_character_url") };
    return { key: root.key };
  } catch {
    return { refusal: apiError("invalid_character_url") };
  }
}

const changed = () =>
  Response.json(dossierStartResponseSchema.parse({ kind: "ready" }), {
    headers: { "cache-control": "no-store" }
  });

export async function PATCH(
  request: Request,
  context: { params: Promise<CharacterParams> }
): Promise<Response> {
  return withHttpRequest("dossier_connection_exclusion", async (scope) => {
    const root = await resolveRoot(context);
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
  context: { params: Promise<CharacterParams> }
): Promise<Response> {
  return withHttpRequest("dossier_connection_removal", async (scope) => {
    const root = await resolveRoot(context);
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
