import { createBlizzardClient } from "@slashwho/blizzard";
import { createRaiderIoClient } from "@slashwho/raiderio";
import type { DossierGatewayOverrides } from "@slashwho/application";

import type { WebConfig } from "./config";

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
      clientSecret: blizzardClientSecret
    });
  }

  const raiderIoAccessKey = headers.get("x-raiderio-access-key")?.trim();
  if (raiderIoAccessKey) {
    overrides.raiderio = createRaiderIoClient({
      fetch: globalThis.fetch,
      baseUrl: config.dossier.raiderIoBaseUrl,
      timeoutMs: config.dossier.raiderIoTimeoutMs,
      accessKey: raiderIoAccessKey
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
