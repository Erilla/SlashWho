import { loadWebConfig } from "../../../../server/config";
import { apiError, withHttpRequest } from "../../../../server/http";
import {
  clearOperatorSessionCookie,
  createOperatorSessionCookie
} from "../../../../server/operator-session";

const noStoreHeaders = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("operator_session_login", async () => {
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      return apiError("unauthorized");
    }

    const body = (await request.json().catch(() => null)) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { operatorKey?: unknown }).operatorKey !== "string"
    ) {
      return apiError("unauthorized");
    }

    const config = loadWebConfig().application;
    const cookie = createOperatorSessionCookie(
      (body as { operatorKey: string }).operatorKey,
      config
    );
    if (cookie === null) return apiError("unauthorized");

    return new Response(null, {
      status: 204,
      headers: { ...noStoreHeaders, "set-cookie": cookie }
    });
  });
}

export async function DELETE(): Promise<Response> {
  return withHttpRequest(
    "operator_session_logout",
    async () =>
      new Response(null, {
        status: 204,
        headers: {
          ...noStoreHeaders,
          "set-cookie": clearOperatorSessionCookie()
        }
      })
  );
}
