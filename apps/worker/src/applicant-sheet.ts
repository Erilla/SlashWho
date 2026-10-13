import { createSign } from "node:crypto";
import { parseApplicantCandidates } from "./applicant-candidates";

const scope = "https://www.googleapis.com/auth/spreadsheets.readonly";

export type ApplicantSheetRow = {
  row: number;
  battletag: unknown;
  discordId: unknown;
  characterName: unknown;
  linkCell: unknown;
  submittedSerial: number | undefined;
};

// `Array.isArray` narrows `unknown` to `any[]`; sheet cells stay `unknown`
// until something checks them.
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

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
  // A token lasts an hour; minting one per read would be 1,440 a day.
  let cachedToken: { value: string; refreshAt: number } | undefined;
  async function headersForRead(): Promise<Record<string, string>> {
    if (options.apiKey !== undefined)
      return { "x-goog-api-key": options.apiKey };
    if (cachedToken && Date.now() < cachedToken.refreshAt)
      return { authorization: `Bearer ${cachedToken.value}` };
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
    const body = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    const token = body.access_token;
    if (typeof token !== "string")
      throw new Error("applicant_google_auth_invalid");
    const lifetimeSeconds =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : 3_600;
    cachedToken = {
      value: token,
      refreshAt: Date.now() + (lifetimeSeconds - 60) * 1_000
    };
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
    if (!response.ok) {
      // A revoked or expired token would otherwise fail every minute's read
      // until its cached lifetime ran out.
      if (response.status === 401 || response.status === 403)
        cachedToken = undefined;
      throw new Error("applicant_sheet_read_rejected");
    }
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
      if (!isList(values) || values.length > 5_000)
        throw new Error("applicant_sheet_bounds_exceeded");
      return values.map((row) => (isList(row) ? row[0] : undefined));
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
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(options.sheetId)}/values:batchGet?${params.toString()}`
      );
      if (!isList(body.valueRanges) || body.valueRanges.length !== 2)
        throw new Error("applicant_sheet_response_invalid");
      const [details, links] = body.valueRanges.map((item) =>
        item && typeof item === "object" && "values" in item ? item.values : []
      );
      if (
        !isList(details) ||
        !isList(links) ||
        details.length > 5_000 ||
        links.length > 5_000
      )
        throw new Error("applicant_sheet_bounds_exceeded");
      // The timestamp is read unformatted, as the spreadsheet's own serial, in
      // a request of its own: unformatted values would turn an 18-digit Discord
      // id in the first read into a lossy double. The link column comes back
      // with it so the two reads can be proved to describe the same rows.
      const serialParams = new URLSearchParams({
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER"
      });
      serialParams.append("ranges", "'Form Responses'!A2:A");
      serialParams.append("ranges", range);
      const second = await readBody(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(options.sheetId)}/values:batchGet?${serialParams.toString().replaceAll("+", "%20")}`
      );
      if (!isList(second.valueRanges) || second.valueRanges.length !== 2)
        throw new Error("applicant_sheet_response_invalid");
      const [serials, recheck] = second.valueRanges.map((item) =>
        item && typeof item === "object" && "values" in item ? item.values : []
      );
      if (
        !isList(serials) ||
        !isList(recheck) ||
        serials.length > 5_000 ||
        recheck.length > 5_000
      )
        throw new Error("applicant_sheet_bounds_exceeded");
      // Forms appends, so a longer second read is rows submitted between the
      // two; anything else -- a sort, a deletion -- would misalign them.
      //
      // The reads use different render options, so the raw cells are not
      // comparable: a bare number, date or boolean renders as text in the first
      // and as a number in the second, and `!==` would fail every tick. Compare
      // what intake actually reads from each cell -- its accepted candidate
      // identities, in order -- instead.
      const cellOf = (rows: readonly unknown[], index: number) => {
        const row = rows[index];
        return isList(row) ? row[0] : undefined;
      };
      const identitiesOf = (rows: readonly unknown[], index: number) =>
        parseApplicantCandidates(cellOf(rows, index))
          .candidates.map((candidate) => candidate.identity)
          .join("\n");
      for (let index = 0; index < links.length; index++) {
        if (identitiesOf(links, index) !== identitiesOf(recheck, index))
          throw new Error("applicant_sheet_rows_moved");
      }
      for (let index = links.length; index < recheck.length; index++) {
        if (index < details.length && identitiesOf(recheck, index) !== "")
          throw new Error("applicant_sheet_rows_moved");
      }
      return Array.from(
        { length: Math.max(details.length, links.length) },
        (_, index) => {
          const detail = details[index];
          const link = links[index];
          return {
            row: index + 2,
            battletag: isList(detail) ? detail[0] : undefined,
            discordId: isList(detail) ? detail[1] : undefined,
            characterName: isList(detail) ? detail[2] : undefined,
            linkCell: isList(link) ? link[0] : undefined,
            submittedSerial: (() => {
              const value = cellOf(serials, index);
              return typeof value === "number" && Number.isFinite(value)
                ? value
                : undefined;
            })()
          };
        }
      );
    }
  };
}
