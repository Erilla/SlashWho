import { collectionMonitorResponseSchema } from "@slashwho/contracts";

import { getContainer } from "../../../../server/container";
import { apiError, withHttpRequest } from "../../../../server/http";

function unauthorized(): Response {
  const response = apiError("unauthorized");
  response.headers.set("www-authenticate", "Bearer");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  return withHttpRequest("collection_monitor", async () => {
    const { collectionMonitor, operatorAuth } = await getContainer();
    const authentication = await operatorAuth.authenticateOperator(request);
    if (!authentication.principal) {
      const response = unauthorized();
      if (authentication.cookie)
        response.headers.set("set-cookie", authentication.cookie.header);
      return response;
    }
    const monitor = collectionMonitorResponseSchema.parse(
      await collectionMonitor.list()
    );
    return Response.json(monitor, {
      headers: {
        "cache-control": "no-store",
        ...(authentication.cookie
          ? { "set-cookie": authentication.cookie.header }
          : {})
      }
    });
  });
}
