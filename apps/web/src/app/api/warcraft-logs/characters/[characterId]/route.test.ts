import {
  safeApiErrorSchema,
  warcraftLogsCharacterResolutionSchema
} from "@slashwho/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { webLogger } from "../../../../../server/logger";
import type {
  CharacterIdResolution,
  CharacterIdResolver
} from "../../../../../server/warcraft-logs-characters";

let resolution: CharacterIdResolution;
let readAllowed:
  { allowed: true } | { allowed: false; retryAfterSeconds: number };
const resolve = vi.fn<CharacterIdResolver["resolve"]>(async () => resolution);

vi.mock("../../../../../server/container", () => ({
  getContainer: async () => ({
    characterIds: { resolve },
    searches: { authorizePublicRead: async () => readAllowed }
  })
}));

vi.mock("../../../../../server/config", () => ({
  loadWebConfig: () => ({
    dossier: {
      raiderIoBaseUrl: "https://raider.io",
      raiderIoTimeoutMs: 10_000,
      blizzardClientId: "blizzard-client-id",
      blizzardClientSecret: "blizzard-client-secret",
      evidenceJobCredentialEncryptionKey: Buffer.alloc(32)
    }
  })
}));

import { GET } from "./route";

function request(headers: Record<string, string> = {}): Request {
  return new Request(
    "https://slashwho.example/api/warcraft-logs/characters/40989140",
    { headers: { "x-real-ip": "203.0.113.8", ...headers } }
  );
}

function context(characterId: string) {
  return { params: Promise.resolve({ characterId }) };
}

beforeEach(() => {
  resolve.mockClear();
  readAllowed = { allowed: true };
  resolution = {
    kind: "character",
    character: {
      characterId: 40989140,
      region: "eu",
      realm: "silvermoon",
      name: "Ryun"
    }
  };
});

describe("GET /api/warcraft-logs/characters/:characterId", () => {
  it("answers with the resolved character and never lets it be cached", async () => {
    const response = await GET(request(), context("40989140"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      warcraftLogsCharacterResolutionSchema.parse(await response.json())
    ).toEqual({
      characterId: 40989140,
      region: "eu",
      realm: "silvermoon",
      name: "Ryun"
    });
    expect(resolve).toHaveBeenCalledWith(
      40989140,
      undefined,
      expect.any(AbortSignal)
    );
  });

  it("times the resolution as a Warcraft Logs call in the request record", async () => {
    // Break caught: an untimed upstream call leaves the http_request record
    // with a durationMs and no breakdown of where it went (#505).
    const info = vi.spyOn(webLogger, "info").mockImplementation(() => {});
    try {
      await GET(request(), context("40989140"));

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "http_request",
          endpoint: "warcraft_logs_character",
          warcraftLogsCalls: 1,
          warcraftLogsMs: expect.any(Number),
          warcraftLogsMaxCallMs: expect.any(Number)
        })
      );
    } finally {
      info.mockRestore();
    }
  });

  it("passes a visitor's own Warcraft Logs credentials through", async () => {
    await GET(
      request({
        "x-wcl-client-id": "visitor-id",
        "x-wcl-client-secret": "visitor-secret"
      }),
      context("40989140")
    );

    expect(resolve).toHaveBeenCalledWith(
      40989140,
      { clientId: "visitor-id", clientSecret: "visitor-secret" },
      expect.any(AbortSignal)
    );
  });

  it.each(["0", "-1", "4.5", "1e6", "abc", "99999999999999999999", "0012"])(
    "rejects the ID %s without spending a request",
    async (characterId) => {
      const response = await GET(request(), context(characterId));

      expect(response.status).toBe(400);
      expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
        "invalid_character_url"
      );
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it("is rate limited as a public read before spending a request", async () => {
    // Break caught: an unthrottled endpoint would let anyone drain the
    // Warcraft Logs hourly allowance the evidence worker depends on.
    readAllowed = { allowed: false, retryAfterSeconds: 7 };

    const response = await GET(request(), context("40989140"));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "not_found" } as const, 404, "character_not_found"],
    [{ kind: "unavailable" } as const, 503, "upstream_unavailable"]
  ])("maps %o to %i", async (result, status, code) => {
    resolution = result;

    const response = await GET(request(), context("40989140"));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      code
    );
  });
});
