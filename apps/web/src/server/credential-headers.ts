import { createBlizzardClient } from "@slashwho/blizzard";
import { createRaiderIoClient } from "@slashwho/raiderio";
import type { DossierGatewayOverrides } from "@slashwho/application";

import type { WebConfig } from "./config";
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
