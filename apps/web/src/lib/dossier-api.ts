import type { CharacterKey } from "@slashwho/domain";

import { credentialHeadersForRequest } from "./api-credentials";
import { characterPathSegments } from "./dossier-path";

export type DossierRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

/** The route that starts research for a character URL. */
export const dossierStartApiPath = "/api/dossiers";

/**
 * A character's dossier API route, or one of its sub-routes. Every segment is
 * encoded, the character's and the caller's alike, so no call site decides for
 * itself which parts of a key need it.
 */
export function dossierApiPath(
  key: CharacterKey,
  ...subPath: readonly string[]
): string {
  return [
    "/api/dossiers",
    characterPathSegments(key),
    ...subPath.map(encodeURIComponent)
  ].join("/");
}

export function dossierJobApiPath(jobId: string): string {
  return `/api/dossiers/jobs/${encodeURIComponent(jobId)}`;
}

/**
 * Fetch a dossier API route with the visitor's saved credentials attached.
 * The dossier read, refresh and tier search routes resolve credential
 * overrides and otherwise fall back to the shared server credentials, so every
 * dossier call goes through here rather than each call site remembering them.
 */
export async function dossierFetch(
  path: string,
  init: DossierRequestInit = {}
): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { ...init.headers, ...(await credentialHeadersForRequest()) }
  });
}

/** A response body as JSON, or null when it is empty or not JSON. */
export function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export type DossierSchema<T> = {
  safeParse(
    value: unknown
  ): { success: true; data: T } | { success: false; data?: undefined };
};

/**
 * What a dossier API call answered. `refused` is any non-2xx status, with the
 * body kept for its error; `unexpected` is a 2xx whose body the schema
 * rejected, which callers report rather than render.
 */
export type DossierApiResult<T> =
  | Readonly<{ kind: "ok"; response: Response; data: T }>
  | Readonly<{ kind: "refused"; response: Response; body: unknown }>
  | Readonly<{ kind: "unexpected"; response: Response }>;

/**
 * `dossierFetch`, then the body parsed against `schema`. It throws only when
 * the request itself does, an abort included, so a caller handles every
 * answer the server gave in one place. A status in `answers` is parsed as a
 * success is, for a route whose refusal still carries the schema's body.
 */
export async function fetchDossierApi<T>(
  path: string,
  schema: DossierSchema<T>,
  init: DossierRequestInit = {},
  { answers = [] }: Readonly<{ answers?: readonly number[] }> = {}
): Promise<DossierApiResult<T>> {
  return parseDossierResponse(await dossierFetch(path, init), schema, {
    answers
  });
}

/** A dossier API response read as `fetchDossierApi` reads its own. */
export async function parseDossierResponse<T>(
  response: Response,
  schema: DossierSchema<T>,
  { answers = [] }: Readonly<{ answers?: readonly number[] }> = {}
): Promise<DossierApiResult<T>> {
  const body = await readJsonBody(response);
  if (!response.ok && !answers.includes(response.status))
    return { kind: "refused", response, body };
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { kind: "ok", response, data: parsed.data }
    : { kind: "unexpected", response };
}
