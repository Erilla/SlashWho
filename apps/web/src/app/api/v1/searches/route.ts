import { createSearchRequestSchema } from "@slashwho/contracts";

import { getContainer } from "../../../../server/container";
import {
  apiError,
  createSearchHttpResponse,
  withHttpRequest
} from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("search", async () => {
    const body = createSearchRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return apiError("invalid_character_url");
    const { searches } = await getContainer();
    return createSearchHttpResponse(
      await searches.create({
        characterUrl: body.data.characterUrl,
        headers: request.headers
      })
    );
  });
}
