import { credentialHeadersForRequest } from "./api-credentials";

export type DossierRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

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
