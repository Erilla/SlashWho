import { collectionMonitorResponseSchema } from "@slashwho/contracts";

import { loadWebConfig } from "../../../../server/config";
import { getContainer } from "../../../../server/container";
import { apiError, withHttpRequest } from "../../../../server/http";
import { isOperatorRequest } from "../../../../server/operator-session";

function unauthorized(): Response {
  const response = apiError("unauthorized");
  response.headers.set("www-authenticate", "Bearer");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  return withHttpRequest("collection_monitor", async () => {
    if (!isOperatorRequest(request.headers, loadWebConfig().application)) {
      return unauthorized();
    }
    const { collectionMonitor } = await getContainer();
    const monitor = collectionMonitorResponseSchema.parse(
      await collectionMonitor.list()
    );
    return Response.json(monitor, {
      headers: { "cache-control": "no-store" }
    });
  });
}
