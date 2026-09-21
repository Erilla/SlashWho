import { NextResponse, type NextRequest } from "next/server";
import { loadWebConfig } from "./server/config";
import { getContainer } from "./server/container";
import { withHttpRequest } from "./server/http";

export async function proxy(request: NextRequest): Promise<Response> {
  // Session mutations are handled exclusively by their guarded API routes.
  if (request.method !== "GET" && request.method !== "HEAD")
    return NextResponse.next();

  return withHttpRequest("operator_page_session", async () => {
    const { operatorAuth } = await getContainer();
    const authentication = await operatorAuth.authenticateOperator(request);
    const response = authentication.principal
      ? NextResponse.next()
      : NextResponse.redirect(
          new URL("/operations/login", loadWebConfig().operatorAuth.origin)
        );
    response.headers.set("cache-control", "no-store");
    if (authentication.cookie)
      response.headers.set("set-cookie", authentication.cookie.header);
    return response;
  });
}

export const config = { matcher: ["/operations/collection-monitor"] };
