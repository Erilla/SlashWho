import type { WarcraftLogsIdentityResult } from "@slashwho/warcraftlogs";
import { describe, expect, it, vi } from "vitest";

import { createCharacterIdResolver } from "./warcraft-logs-characters";

const identity: WarcraftLogsIdentityResult = {
  kind: "identity",
  key: { region: "eu", realm: "silvermoon", name: "ryun" },
  displayName: "Ryun",
  characterId: 40989140
};

function gatewayAnswering(result: WarcraftLogsIdentityResult) {
  return { resolveCharacterById: vi.fn(async () => result) };
}

describe("character ID resolution", () => {
  it("resolves an ID to the character's current name, realm and region", async () => {
    const gateway = gatewayAnswering(identity);
    const resolver = createCharacterIdResolver({
      credentials: { clientId: "server-id", clientSecret: "server-secret" },
      createGateway: () => gateway
    });

    await expect(resolver.resolve(40989140)).resolves.toEqual({
      kind: "character",
      character: {
        characterId: 40989140,
        region: "eu",
        realm: "silvermoon",
        name: "Ryun"
      }
    });
    expect(gateway.resolveCharacterById).toHaveBeenCalledWith(
      40989140,
      undefined
    );
  });

  it("builds the shared gateway once, from the server's credentials", async () => {
    // Break caught: a gateway per request would fetch an OAuth token per paste.
    const createGateway = vi.fn(() => gatewayAnswering(identity));
    const resolver = createCharacterIdResolver({
      credentials: {
        clientId: "server-id",
        clientSecret: "server-secret",
        baseUrl: "http://127.0.0.1:4321"
      },
      createGateway
    });

    await resolver.resolve(1);
    await resolver.resolve(2);

    expect(createGateway).toHaveBeenCalledTimes(1);
    expect(createGateway).toHaveBeenCalledWith({
      clientId: "server-id",
      clientSecret: "server-secret",
      baseUrl: "http://127.0.0.1:4321"
    });
  });

  it("prefers the visitor's own credentials, against the configured origin", async () => {
    // Break caught: a visitor who supplied a key would still spend the
    // server's allowance, or be sent to production from a local fake.
    const createGateway = vi.fn(() => gatewayAnswering(identity));
    const resolver = createCharacterIdResolver({
      credentials: {
        clientId: "server-id",
        clientSecret: "server-secret",
        baseUrl: "http://127.0.0.1:4321"
      },
      createGateway
    });

    await resolver.resolve(1, {
      clientId: "visitor-id",
      clientSecret: "visitor-secret"
    });

    expect(createGateway).toHaveBeenCalledOnce();
    expect(createGateway).toHaveBeenCalledWith({
      clientId: "visitor-id",
      clientSecret: "visitor-secret",
      baseUrl: "http://127.0.0.1:4321"
    });
  });

  it("reports the upstream as unavailable when no credentials exist", async () => {
    // Break caught: an unconfigured deployment would throw a 500 on paste.
    const createGateway = vi.fn(() => gatewayAnswering(identity));
    const resolver = createCharacterIdResolver({ createGateway });

    await expect(resolver.resolve(1)).resolves.toEqual({
      kind: "unavailable"
    });
    expect(createGateway).not.toHaveBeenCalled();
  });

  it.each(["not_found", "private"] as const)(
    "reports a %s character as not found",
    async (code) => {
      const resolver = createCharacterIdResolver({
        credentials: { clientId: "id", clientSecret: "secret" },
        createGateway: () => gatewayAnswering({ kind: "limitation", code })
      });

      await expect(resolver.resolve(1)).resolves.toEqual({
        kind: "not_found"
      });
    }
  );

  it.each(["unavailable", "rate_limited", "schema_drift"] as const)(
    "reports a %s limitation as unavailable",
    async (code) => {
      const resolver = createCharacterIdResolver({
        credentials: { clientId: "id", clientSecret: "secret" },
        createGateway: () => gatewayAnswering({ kind: "limitation", code })
      });

      await expect(resolver.resolve(1)).resolves.toEqual({
        kind: "unavailable"
      });
    }
  );
});
