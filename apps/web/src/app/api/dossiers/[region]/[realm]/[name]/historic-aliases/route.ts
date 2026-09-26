import {
  characterKeySchema,
  dossierStartResponseSchema
} from "@slashwho/contracts";
import { parseApplicantCharacterUrl } from "@slashwho/domain";

import { getContainer } from "../../../../../../../server/container";
import {
  apiError,
  jsonNoStore,
  resolveCharacterRoute,
  withHttpRequest
} from "../../../../../../../server/http";

function parseBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "character,name,realm")
    return null;
  const character = characterKeySchema.safeParse(body.character);
  if (
    !character.success ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    typeof body.realm !== "string" ||
    !body.realm.trim()
  )
    return null;
  return { character: character.data, name: body.name, realm: body.realm };
}

type CharacterContext =
  RouteContext<"/api/dossiers/[region]/[realm]/[name]/historic-aliases">;

async function change(
  method: "POST" | "DELETE",
  request: Request,
  context: CharacterContext
): Promise<Response> {
  return withHttpRequest("dossier_historic_alias", async (scope) => {
    const root = await resolveCharacterRoute(context, {
      requireCanonical: true
    });
    if ("refusal" in root) return root.refusal;
    const body = parseBody(await request.json().catch(() => null));
    if (!body) return apiError("invalid_character_url");
    let alias: ReturnType<typeof parseApplicantCharacterUrl>;
    try {
      alias = parseApplicantCharacterUrl(
        `https://www.warcraftlogs.com/character/${body.character.region}/${encodeURIComponent(body.realm)}/${encodeURIComponent(body.name)}`
      );
    } catch {
      return apiError("invalid_character_url");
    }
    const { dossiers } = await getContainer();
    const result =
      method === "POST"
        ? await dossiers.addHistoricAlias(
            root.key,
            body.character,
            alias,
            scope
          )
        : await dossiers.removeHistoricAlias(
            root.key,
            body.character,
            alias,
            scope
          );
    if (result === "added" || result === "removed") {
      return jsonNoStore(dossierStartResponseSchema, { kind: "ready" });
    }
    if (result === "duplicate") return apiError("historic_alias_duplicate");
    if (result === "self") return apiError("historic_alias_self");
    return apiError(
      method === "POST" ? "connection_not_found" : "historic_alias_not_found"
    );
  });
}

export const POST = (request: Request, context: CharacterContext) =>
  change("POST", request, context);

export const DELETE = (request: Request, context: CharacterContext) =>
  change("DELETE", request, context);
