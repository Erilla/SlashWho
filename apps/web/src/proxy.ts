import { NextResponse, type NextRequest } from "next/server";
import { loadWebConfig } from "./server/config";
import { getContainer } from "./server/container";
import { withHttpRequest } from "./server/http";
import { authorizes } from "./server/operator-auth";

export async function proxy(request: NextRequest): Promise<Response> {
  // Session mutations are handled exclusively by their guarded API routes.
  if (request.method !== "GET" && request.method !== "HEAD")
    return NextResponse.next();

  return withHttpRequest("admin_page_session", async () => {
    const { accountAuth } = await getContainer();
    const authentication = await accountAuth.authenticate(request);
    const response = authorizes(authentication.principal, "admin")
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

export const config = {
  matcher: ["/operations/collection-monitor", "/admin/settings/:path*"]
};
