import { createDossierRequestSchema } from "@slashwho/contracts";

import { getContainer } from "../../../server/container";
import {
  apiError,
  createSearchHttpResponse,
  withHttpRequest
} from "../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("dossier_start", async () => {
    const body = createDossierRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return apiError("invalid_character_url");
    const { dossiers } = await getContainer();
    return createSearchHttpResponse(
      await dossiers.start({
        characterUrl: body.data.characterUrl,
        headers: request.headers
      })
    );
  });
}
