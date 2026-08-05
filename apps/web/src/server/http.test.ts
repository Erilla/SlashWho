import {
  characterResourceSchema,
  createSearchResponseSchema,
  safeApiErrorSchema
} from "@slashwho/contracts";
import { describe, expect, it } from "vitest";

import {
  apiError,
  createSearchHttpResponse,
  parseCharacterRoute,
  publicResourceResponse,
  withHttpRequest
} from "./http";

const character = characterResourceSchema.parse({
  character: {
    region: "eu",
    realm: "silvermoon",
    name: "Ryii",
    className: "Mage",
    level: 80,
    raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii"
  },
  snapshot: {
    id: "13af3173-e97c-4c78-a6cb-a54b647b209f",
    state: "complete",
    refreshedAt: "2026-08-04T12:30:00.000Z",
    characterCount: 1,
    characters: [
      {
        region: "eu",
        realm: "silvermoon",
        name: "Ryii",
        className: "Mage",
        level: 80,
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii"
      }
    ]
  },
  activeJob: null
});

describe("HTTP result mapping", () => {
  it("maps queued work to a schema-valid 202 with no-store and Location", async () => {
    // Break caught: queued work could be mistaken for a completed cache hit.
    const response = createSearchHttpResponse({
      kind: "job",
      jobId: "54f14e37-7df7-43db-91d5-21e797d1d145",
      status: "queued",
      statusUrl: "/api/v1/searches/54f14e37-7df7-43db-91d5-21e797d1d145",
      characterUrl: "/characters/eu/silvermoon/ryii",
      staleCharacter: null
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(
      "/api/v1/searches/54f14e37-7df7-43db-91d5-21e797d1d145"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createSearchResponseSchema.parse(await response.json()).kind).toBe(
      "job"
    );
  });

  it("serves stale data while exposing its active refresh", async () => {
    // Break caught: a stale snapshot could disappear while its refresh is queued.
    const staleCharacter = characterResourceSchema.parse({
      ...character,
      activeJob: {
        jobId: "54f14e37-7df7-43db-91d5-21e797d1d145",
        status: "queued",
        statusUrl: "/api/v1/searches/54f14e37-7df7-43db-91d5-21e797d1d145"
      }
    });
    const response = createSearchHttpResponse({
      kind: "job",
      jobId: "54f14e37-7df7-43db-91d5-21e797d1d145",
      status: "queued",
      statusUrl: "/api/v1/searches/54f14e37-7df7-43db-91d5-21e797d1d145",
      characterUrl: "/characters/eu/silvermoon/ryii",
      staleCharacter
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toContain("/api/v1/searches/");
    expect(createSearchResponseSchema.parse(await response.json())).toEqual({
      kind: "character",
      character: staleCharacter
    });
  });

  it("returns strict safe errors and Retry-After without internal detail", async () => {
    // Break caught: rate-limit responses could leak bucket identifiers or omit retry timing.
    const response = apiError("rate_limited", {
      retryAfterSeconds: 37
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(safeApiErrorSchema.parse(await response.json())).toEqual({
      error: { code: "rate_limited", message: "Too many requests." }
    });
  });

  it("caches only successful public resources", () => {
    // Break caught: public snapshots could become uncacheable or errors could be cached.
    const response = publicResourceResponse(character);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300"
    );
  });

  it("attaches a generated correlation id and logs only request metadata", async () => {
    // Break caught: requests could be impossible to correlate without logging user input.
    const events: Record<string, unknown>[] = [];
    const response = await withHttpRequest(
      "character",
      async () => publicResourceResponse(character),
      {
        info(event) {
          events.push(event);
        }
      },
      () => 100
    );

    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(events).toEqual([
      {
        event: "http_request",
        correlationId: response.headers.get("x-request-id"),
        endpoint: "character",
        status: 200,
        durationMs: 0,
        count: 1
      }
    ]);
  });
});

describe("character route parsing", () => {
  it("canonicalizes supported route casing and rejects invalid keys", () => {
    // Break caught: alternate casing could create two public URLs for one character.
    expect(
      parseCharacterRoute({
        region: "EU",
        realm: "Silvermoon",
        name: "Ryii"
      })
    ).toEqual({
      key: { region: "eu", realm: "silvermoon", name: "ryii" },
      canonical: false
    });
    expect(() =>
      parseCharacterRoute({ region: "xx", realm: "Silvermoon", name: "Ryii" })
    ).toThrow("invalid_character_url");
  });
});
