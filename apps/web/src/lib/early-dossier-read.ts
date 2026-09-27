import { credentialStorageKey } from "./api-credentials";
import {
  fetchDossierApi,
  parseDossierResponse,
  type DossierApiResult,
  type DossierRequestInit,
  type DossierSchema
} from "./dossier-api";

/** Where the shell's script leaves the read it started, for the client. */
const earlyReadSlot = "__slashwhoEarlyDossierRead";

type EarlyRead = Readonly<{ path: string; response: Promise<Response> }>;

/** A string as a script literal that cannot close the `<script>` it is in. */
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The shell's inline script, which starts a dossier's first read while the
 * HTML is still parsing rather than after the client has hydrated (#667).
 *
 * It sends exactly the request the client would: `GET` with `no-store` and
 * the visitor's cookies. A visitor with credentials saved in this browser is
 * left to the client, whose `credentialHeadersForRequest` checks the account
 * session before attaching them; any saved value is enough to stand aside,
 * so the script never sends a read the client would have sent differently.
 */
export function earlyDossierReadScript(path: string): string {
  return `(function(path,key,slot){try{var raw=window.localStorage.getItem(key);if(raw){var saved=JSON.parse(raw);for(var field in saved){if(typeof saved[field]==="string"&&saved[field])return;}}}catch(e){}try{var response=fetch(path,{cache:"no-store",headers:{}});response.catch(function(){});window[slot]={path:path,response:response};}catch(e){}})(${scriptLiteral(path)},${scriptLiteral(credentialStorageKey)},${scriptLiteral(earlyReadSlot)});`;
}

/**
 * The response to the read the shell started for `path`, at most once. The
 * slot is emptied whatever it held, so a later read, or a read of another
 * page reached by client navigation, always goes to the network.
 */
export function takeEarlyDossierRead(path: string): Promise<Response> | null {
  const holder = window as unknown as Record<string, EarlyRead | undefined>;
  const early = holder[earlyReadSlot];
  if (!early) return null;
  delete holder[earlyReadSlot];
  return early.path === path ? early.response : null;
}

/**
 * A page's first full dossier read: the shell's read when it started one,
 * otherwise `fetchDossierApi`. The shell's read cannot be aborted, so a caller
 * checks its own signal once this settles, as it does after any read.
 */
export async function fetchFirstDossierRead<T>(
  path: string,
  schema: DossierSchema<T>,
  init: DossierRequestInit = {}
): Promise<DossierApiResult<T>> {
  const early = takeEarlyDossierRead(path);
  return early
    ? parseDossierResponse(await early, schema)
    : fetchDossierApi(path, schema, init);
}
