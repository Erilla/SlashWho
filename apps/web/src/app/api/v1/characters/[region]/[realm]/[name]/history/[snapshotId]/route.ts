import { getContainer } from "../../../../../../../../../server/container";
import {
  apiError,
  canonicalApiCharacterPath,
  isUuid,
  parseCharacterRoute,
  publicReadAuthorizationResponse,
  publicResourceResponse,
  withHttpRequest
} from "../../../../../../../../../server/http";

type SnapshotParams = {
  region: string;
  realm: string;
  name: string;
  snapshotId: string;
};

export async function GET(
  request: Request,
  context: { params: Promise<SnapshotParams> }
): Promise<Response> {
  return withHttpRequest("snapshot", async () => {
    const params = await context.params;
    if (!isUuid(params.snapshotId)) return apiError("character_not_found");
    let parsed: ReturnType<typeof parseCharacterRoute>;
    try {
      parsed = parseCharacterRoute(params);
    } catch {
      return apiError("invalid_character_url");
    }
    if (!parsed.canonical) {
      return new Response(null, {
        status: 308,
        headers: {
          "cache-control": "no-store",
          location: `${canonicalApiCharacterPath(parsed.key)}/history/${params.snapshotId}`
        }
      });
    }
    const { searches } = await getContainer();
    const denied = publicReadAuthorizationResponse(
      await searches.authorizePublicRead(request.headers)
    );
    if (denied) return denied;
    const result = await searches.getSnapshot(parsed.key, params.snapshotId);
    return result
      ? publicResourceResponse(result, {
          authenticated: request.headers.get("authorization") !== null
        })
      : apiError("character_not_found");
  });
}
