import { characterKeySchema } from "@slashwho/contracts";
import { parseApplicantCharacterUrl } from "@slashwho/domain";

import { getContainer } from "../../../../../../../server/container";
import {
  apiError,
  parseCharacterRoute,
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

type CharacterParams = { region: string; realm: string; name: string };

async function change(
  method: "POST" | "DELETE",
  request: Request,
  context: { params: Promise<CharacterParams> }
): Promise<Response> {
  return withHttpRequest("dossier_historic_alias", async (scope) => {
    let root: ReturnType<typeof parseCharacterRoute>;
    try {
      root = parseCharacterRoute(await context.params);
    } catch {
      return apiError("invalid_character_url");
    }
    if (!root.canonical) return apiError("invalid_character_url");
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
      return Response.json(
        { kind: "ready" },
        {
          headers: { "cache-control": "no-store" }
        }
      );
    }
    if (result === "duplicate") return apiError("historic_alias_duplicate");
    if (result === "self") return apiError("historic_alias_self");
    return apiError(
      method === "POST" ? "connection_not_found" : "historic_alias_not_found"
    );
  });
}

export const POST = (
  request: Request,
  context: { params: Promise<CharacterParams> }
) => change("POST", request, context);

export const DELETE = (
  request: Request,
  context: { params: Promise<CharacterParams> }
) => change("DELETE", request, context);
