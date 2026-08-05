import { getContainer } from "../../../../../../../server/container";
import {
  apiError,
  canonicalApiCharacterPath,
  parseCharacterRoute,
  publicReadAuthorizationResponse,
  publicResourceResponse,
  withHttpRequest
} from "../../../../../../../server/http";

type CharacterParams = { region: string; realm: string; name: string };

export async function GET(
  request: Request,
  context: { params: Promise<CharacterParams> }
): Promise<Response> {
  return withHttpRequest("character", async () => {
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
          location: canonicalApiCharacterPath(parsed.key)
        }
      });
    }
    const { searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers)
    );
    if (denied) return denied;
    const result = await searches.getCurrent(parsed.key);
    return result
      ? publicResourceResponse(result, {
          authenticated: request.headers.get("authorization") !== null
        })
      : apiError("character_not_found");
  });
}
