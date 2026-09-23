import { createBlizzardClient } from "@slashwho/blizzard";
import { createRaiderIoClient } from "@slashwho/raiderio";
import type { DossierGatewayOverrides } from "@slashwho/application";

import type { WebConfig } from "./config";
import type { ProviderCredentials } from "./account-credentials";
import { webLogger } from "./logger";

/**
 * A visitor-supplied client reports throttling exactly as the container's
 * shared clients do, so an upstream throttling one visitor's own key is as
 * visible as one throttling the server's. The record names the provider and
 * the delay only: the header values that built the client are never on it,
 * and `allowedFields` in the web logger would drop them even if they were.
 */
function throttleReporter(provider: "blizzard" | "raiderio") {
  return (event: { retryAfterMs: number | undefined }) =>
    webLogger.info({
      event: "upstream_throttle",
      provider,
      retryAfterMs: event.retryAfterMs ?? null
    });
}

export function readCredentialOverrides(
  headers: Headers,
  config: WebConfig
): DossierGatewayOverrides {
  const overrides: {
    blizzard?: DossierGatewayOverrides["blizzard"];
    raiderio?: DossierGatewayOverrides["raiderio"];
    wclCredentials?: DossierGatewayOverrides["wclCredentials"];
  } = {};

  const blizzardClientId = headers.get("x-blizzard-client-id")?.trim();
  const blizzardClientSecret = headers.get("x-blizzard-client-secret")?.trim();
  if (blizzardClientId && blizzardClientSecret) {
    overrides.blizzard = createBlizzardClient({
      fetch: globalThis.fetch,
      clientId: blizzardClientId,
      clientSecret: blizzardClientSecret,
      onThrottle: throttleReporter("blizzard")
    });
  }

  const raiderIoAccessKey = headers.get("x-raiderio-access-key")?.trim();
  if (raiderIoAccessKey) {
    overrides.raiderio = createRaiderIoClient({
      fetch: globalThis.fetch,
      baseUrl: config.dossier.raiderIoBaseUrl,
      timeoutMs: config.dossier.raiderIoTimeoutMs,
      accessKey: raiderIoAccessKey,
      onThrottle: throttleReporter("raiderio")
    });
  }

  const wclClientId = headers.get("x-wcl-client-id")?.trim();
  const wclClientSecret = headers.get("x-wcl-client-secret")?.trim();
  if (wclClientId && wclClientSecret) {
    overrides.wclCredentials = {
      clientId: wclClientId,
      clientSecret: wclClientSecret
    };
  }

  return overrides;
}

export async function resolveCredentialOverrides(
  request: Request,
  principal:
    { kind: "account"; accountId: string } | { kind: "automation" } | null,
  accountCredentials:
    | {
        resolve(
          accountId: string,
          provider: "blizzard" | "raiderio" | "warcraftlogs"
        ): Promise<{ values: ProviderCredentials; version: number } | null>;
      }
    | null
    | undefined,
  config: WebConfig
): Promise<DossierGatewayOverrides> {
  if (principal?.kind !== "account")
    return readCredentialOverrides(request.headers, config);
  if (!accountCredentials) return {};
  const [blizzard, raiderio, wcl] = await Promise.all([
    accountCredentials.resolve(principal.accountId, "blizzard"),
    accountCredentials.resolve(principal.accountId, "raiderio"),
    accountCredentials.resolve(principal.accountId, "warcraftlogs")
  ]);
  const headers = new Headers();
  if (blizzard?.values && "clientId" in blizzard.values) {
    headers.set("x-blizzard-client-id", blizzard.values.clientId);
    headers.set("x-blizzard-client-secret", blizzard.values.clientSecret);
  }
  if (raiderio?.values && "accessKey" in raiderio.values)
    headers.set("x-raiderio-access-key", raiderio.values.accessKey);
  if (wcl?.values && "clientId" in wcl.values) {
    headers.set("x-wcl-client-id", wcl.values.clientId);
    headers.set("x-wcl-client-secret", wcl.values.clientSecret);
  }
  return {
    ...readCredentialOverrides(headers, config),
    ...(wcl?.values && "clientId" in wcl.values
      ? {
          wclCredentialRef: {
            accountId: principal.accountId,
            credentialVersion: wcl.version
          }
        }
      : {})
  };
}
