import { createSign } from "node:crypto";

const scope = "https://www.googleapis.com/auth/spreadsheets.readonly";

export type ApplicantSheetRow = {
  row: number;
  battletag: unknown;
  discordId: unknown;
  characterName: unknown;
  linkCell: unknown;
};

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** Reads the configured links and selected applicant fields; errors expose categories only. */
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
  async function headersForRead(): Promise<Record<string, string>> {
    if (options.apiKey !== undefined)
      return { "x-goog-api-key": options.apiKey };
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
    let response: Response;
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
    return { authorization: `Bearer ${token}` };
  }

  async function readBody(url: string): Promise<Record<string, unknown>> {
    let response: Response;
    const headers = await headersForRead();
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new Error("applicant_sheet_unavailable");
    }
    if (!response.ok) throw new Error("applicant_sheet_read_rejected");
    const raw = await response.text();
    if (raw.length > 2_000_000)
      throw new Error("applicant_sheet_bounds_exceeded");
    try {
      const body: unknown = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error();
      return body as Record<string, unknown>;
    } catch {
      throw new Error("applicant_sheet_response_invalid");
    }
  }
  return {
    async readColumn(): Promise<unknown[]> {
      const body = await readBody(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(options.sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`
      );
      const values = body.values ?? [];
      if (!Array.isArray(values) || values.length > 5_000)
        throw new Error("applicant_sheet_bounds_exceeded");
      return values.map((row: unknown) =>
        Array.isArray(row) ? row[0] : undefined
      );
    },
    async readRows(): Promise<ApplicantSheetRow[]> {
      const detailRange = "'Form Responses'!B2:D";
      const params = new URLSearchParams({
        majorDimension: "ROWS",
        valueRenderOption: "FORMATTED_VALUE"
      });
      params.append("ranges", detailRange);
      params.append("ranges", range);
      const body = await readBody(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(options.sheetId)}/values:batchGet?${params}`
      );
      if (!Array.isArray(body.valueRanges) || body.valueRanges.length !== 2)
        throw new Error("applicant_sheet_response_invalid");
      const [details, links] = body.valueRanges.map((item: unknown) =>
        item && typeof item === "object" && "values" in item
          ? (item as { values: unknown }).values
          : []
      );
      if (
        !Array.isArray(details) ||
        !Array.isArray(links) ||
        details.length > 5_000 ||
        links.length > 5_000
      )
        throw new Error("applicant_sheet_bounds_exceeded");
      return Array.from(
        { length: Math.max(details.length, links.length) },
        (_, index) => {
          const detail = details[index];
          const link = links[index];
          return {
            row: index + 2,
            battletag: Array.isArray(detail) ? detail[0] : undefined,
            discordId: Array.isArray(detail) ? detail[1] : undefined,
            characterName: Array.isArray(detail) ? detail[2] : undefined,
            linkCell: Array.isArray(link) ? link[0] : undefined
          };
        }
      );
    }
  };
}
