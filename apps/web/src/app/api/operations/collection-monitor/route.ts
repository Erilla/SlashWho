import {
  collectionMonitorCompletedLimitMax,
  collectionMonitorCompletedPageSize,
  collectionMonitorResponseSchema
} from "@slashwho/contracts";

import { getContainer } from "../../../../server/container";
import { apiError, withHttpRequest } from "../../../../server/http";
import { authorizes } from "../../../../server/operator-auth";

function unauthorized(): Response {
  const response = apiError("unauthorized");
  response.headers.set("www-authenticate", "Bearer");
  return response;
}

/** The requested completed-run limit, held to what one read may return. */
function completedLimit(request: Request): number {
  const requested = Number(
    new URL(request.url).searchParams.get("completedLimit")
  );
  if (!Number.isSafeInteger(requested)) {
    return collectionMonitorCompletedPageSize;
  }
  return Math.min(
    collectionMonitorCompletedLimitMax,
    Math.max(collectionMonitorCompletedPageSize, requested)
  );
}

export async function GET(request: Request): Promise<Response> {
  return withHttpRequest("collection_monitor", async (scope) => {
    const { collectionMonitor, accountAuth } = await getContainer();
    const authentication = await accountAuth.authenticate(request, scope);
    if (
      authentication.principal?.kind === "account" &&
      !authorizes(authentication.principal, "admin")
    ) {
      return Response.json(
        { error: "forbidden" },
        {
          status: 403,
          headers: {
            "cache-control": "no-store",
            ...(authentication.cookie
              ? { "set-cookie": authentication.cookie.header }
              : {})
          }
        }
      );
    }
    if (!authentication.principal) {
      const response = unauthorized();
      if (authentication.cookie)
        response.headers.set("set-cookie", authentication.cookie.header);
      return response;
    }
    const monitor = collectionMonitorResponseSchema.parse(
      await collectionMonitor.list({ completedLimit: completedLimit(request) })
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
