import { createSign } from "node:crypto";

const scope = "https://www.googleapis.com/auth/spreadsheets.readonly";

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** Reads only one configured column; errors expose categories only. */
export function createApplicantSheetClient(
  options: {
    sheetId: string;
    column: string;
    fetch?: typeof globalThis.fetch;
  } & (
    | { apiKey: string; email?: never; privateKey?: never }
    | { apiKey?: never; email: string; privateKey: string }
  )
) {
  const fetch = options.fetch ?? globalThis.fetch;
  const range = `'Form Responses'!${options.column}2:${options.column}`;
  return {
    async readColumn(): Promise<unknown[]> {
      let headers: Record<string, string>;
      let response: Response;
      if (options.apiKey !== undefined) {
        headers = { "x-goog-api-key": options.apiKey };
      } else {
        const now = Math.floor(Date.now() / 1000);
        const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const payload = base64url(
          JSON.stringify({
            iss: options.email,
            scope,
            aud: "https://oauth2.googleapis.com/token",
            iat: now,
            exp: now + 300
          })
        );
        const sign = createSign("RSA-SHA256");
        sign.update(`${header}.${payload}`);
        const assertion = `${header}.${payload}.${sign.sign(options.privateKey).toString("base64url")}`;
        try {
          response = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
              assertion
            }),
            signal: AbortSignal.timeout(10_000)
          });
        } catch {
          throw new Error("applicant_google_auth_unavailable");
        }
        if (!response.ok) throw new Error("applicant_google_auth_rejected");
        const token = ((await response.json()) as { access_token?: unknown })
          .access_token;
        if (typeof token !== "string")
          throw new Error("applicant_google_auth_invalid");
        headers = { authorization: `Bearer ${token}` };
      }
      try {
        response = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(options.sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
          {
            headers,
            signal: AbortSignal.timeout(15_000)
          }
        );
      } catch {
        throw new Error("applicant_sheet_unavailable");
      }
      if (!response.ok) throw new Error("applicant_sheet_read_rejected");
      const raw = await response.text();
      if (raw.length > 2_000_000)
        throw new Error("applicant_sheet_bounds_exceeded");
      let body: { values?: unknown };
      try {
        body = JSON.parse(raw) as { values?: unknown };
      } catch {
        throw new Error("applicant_sheet_response_invalid");
      }
      const values = body.values ?? [];
      if (!Array.isArray(values) || values.length > 5_000)
        throw new Error("applicant_sheet_bounds_exceeded");
      return values.map((row: unknown) =>
        Array.isArray(row) ? row[0] : undefined
      );
    }
  };
}
