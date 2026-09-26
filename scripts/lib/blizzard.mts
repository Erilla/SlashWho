import { requiredEnvironment } from "./cli.mts";

/** A client-credentials access token from `BLIZZARD_CLIENT_ID`/`_SECRET`. */
export async function blizzardAccessToken(
  region: string,
  failureCode: string
): Promise<string> {
  const clientId = requiredEnvironment("BLIZZARD_CLIENT_ID");
  const clientSecret = requiredEnvironment("BLIZZARD_CLIENT_SECRET");
  const response = await fetch(`https://${region}.battle.net/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
    },
    body: "grant_type=client_credentials"
  });
  const body = (await response.json()) as { access_token?: unknown };
  if (
    !response.ok ||
    typeof body.access_token !== "string" ||
    !body.access_token
  ) {
    throw new Error(failureCode);
  }
  return body.access_token;
}
