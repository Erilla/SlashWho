import { getContainer } from "../../../../../../../../server/container";
import {
  apiError,
  canonicalApiCharacterPath,
  isHistoryCursor,
  parseCharacterRoute,
  publicReadAuthorizationResponse,
  publicResourceResponse,
  withHttpRequest
} from "../../../../../../../../server/http";

type CharacterParams = { region: string; realm: string; name: string };

export async function GET(
  request: Request,
  context: { params: Promise<CharacterParams> }
): Promise<Response> {
  return withHttpRequest("history", async () => {
    let parsed: ReturnType<typeof parseCharacterRoute>;
    try {
      parsed = parseCharacterRoute(await context.params);
    } catch {
      return apiError("invalid_character_url");
    }
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !isHistoryCursor(cursor)) {
      return apiError("invalid_character_url");
    }
    if (!parsed.canonical) {
      const canonical = `${canonicalApiCharacterPath(parsed.key)}/history`;
      return new Response(null, {
        status: 308,
        headers: {
          "cache-control": "no-store",
          location: `${canonical}${url.search}`
        }
      });
    }
    const { searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers)
    );
    if (denied) return denied;
    const result = await searches.getHistory(parsed.key, cursor ?? undefined);
    return result
      ? publicResourceResponse(result, {
          authenticated: request.headers.get("authorization") !== null
        })
      : apiError("character_not_found");
  });
}
