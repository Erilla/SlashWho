import { safeApiErrorSchema } from "@slashwho/contracts";
import type {
  PublicReadAuthorizationResult,
  MeasurementScope
} from "@slashwho/application";
import { beforeEach, describe, expect, it, vi } from "vitest";

const characterUrl = "https://raider.io/characters/eu/silvermoon/manual";

let exclusion: unknown;
let removal: unknown;
const exclusionCalls: unknown[] = [];
const removalCalls: unknown[] = [];
let admission: PublicReadAuthorizationResult;
const admissionCalls: {
  headers: Pick<Headers, "get">;
  scope?: MeasurementScope | undefined;
}[] = [];
const searches = {
  async authorizeConnectionMutation(
    headers: Pick<Headers, "get">,
    scope?: MeasurementScope
  ) {
    admissionCalls.push({ headers, scope });
    return admission;
  }
};

const dossiers = {
  async addConnectedCharacter() {
    return { kind: "linked" as const };
  },
  async setConnectedCharacterExclusion(root: unknown, input: unknown) {
    exclusionCalls.push({ root, input });
    return exclusion;
  },
  async removeConnectedCharacter(root: unknown, input: unknown) {
    removalCalls.push({ root, input });
    return removal;
  }
};

vi.mock("../../../../../../../server/container", () => ({
  getContainer: async () => ({ dossiers, searches })
}));

import { DELETE, PATCH } from "./route";

const characterContext = {
  params: Promise.resolve({ region: "eu", realm: "silvermoon", name: "ryii" })
};

function request(method: "PATCH" | "DELETE", body: unknown): Request {
  return new Request(
    "https://slashwho.example/api/dossiers/eu/silvermoon/ryii/connected-characters",
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.8"
      },
      body: JSON.stringify(body)
    }
  );
}

beforeEach(() => {
  exclusion = { kind: "updated" };
  removal = { kind: "removed" };
  exclusionCalls.length = 0;
  removalCalls.length = 0;
  admission = { allowed: true };
  admissionCalls.length = 0;
});

describe.each(["PATCH", "DELETE"] as const)(
  "%s connection mutation admission",
  (method) => {
    const handler = method === "PATCH" ? PATCH : DELETE;
    const body =
      method === "PATCH" ? { characterUrl, excluded: true } : { characterUrl };

    it("forwards caller headers and the request scope before mutation", async () => {
      const input = request(method, body);
      const response = await handler(input, characterContext);
      expect(response.status).toBe(200);
      expect(admissionCalls).toHaveLength(1);
      expect(admissionCalls[0]?.headers).toBe(input.headers);
      expect(admissionCalls[0]?.scope).toEqual(
        expect.objectContaining({ totals: expect.any(Function) })
      );
    });

    it("returns a safe 429 with Retry-After and leaves both mutations untouched", async () => {
      admission = { allowed: false, retryAfterSeconds: 19 };
      const response = await handler(request(method, body), characterContext);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("19");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
        "rate_limited"
      );
      expect(exclusionCalls).toEqual([]);
      expect(removalCalls).toEqual([]);
    });

    it.each(["unauthorized", "trusted_client_ip_unavailable"] as const)(
      "refuses %s without mutation",
      async (code) => {
        admission = { allowed: false, code };
        const response = await handler(request(method, body), characterContext);
        expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
          code
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(exclusionCalls).toEqual([]);
        expect(removalCalls).toEqual([]);
      }
    );

    it("rejects an invalid body without reserving", async () => {
      const response = await handler(request(method, {}), characterContext);
      expect(response.status).toBe(400);
      expect(admissionCalls).toEqual([]);
    });

    it("rejects a non-canonical root without reserving", async () => {
      const response = await handler(request(method, body), {
        params: Promise.resolve({
          region: "EU",
          realm: "Silvermoon",
          name: "Ryii"
        })
      });
      expect(response.status).toBe(400);
      expect(admissionCalls).toEqual([]);
    });
  }
);

describe("PATCH /api/dossiers/:region/:realm/:name/connected-characters", () => {
  it("excludes the named character from the dossier evidence", async () => {
    const response = await PATCH(
      request("PATCH", { characterUrl, excluded: true }),
      characterContext
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: "ready" });
    expect(exclusionCalls).toEqual([
      {
        root: { region: "eu", realm: "silvermoon", name: "ryii" },
        input: { characterUrl, excluded: true }
      }
    ]);
  });

  it("restores a character a reviewer includes again", async () => {
    await PATCH(
      request("PATCH", { characterUrl, excluded: false }),
      characterContext
    );

    expect(exclusionCalls).toEqual([
      {
        root: { region: "eu", realm: "silvermoon", name: "ryii" },
        input: { characterUrl, excluded: false }
      }
    ]);
  });

  it("reports a link another reviewer has already removed", async () => {
    // Two reviewers can hold the same dossier. The second must be told the
    // link has gone rather than shown a change it did not make.
    exclusion = { kind: "missing" };

    const response = await PATCH(
      request("PATCH", { characterUrl, excluded: true }),
      characterContext
    );

    expect(response.status).toBe(404);
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      "connection_not_found"
    );
  });

  it("refuses a body without an exclusion without reflecting it", async () => {
    const marker = "private-marker-exclusion";

    const response = await PATCH(
      request("PATCH", { characterUrl: marker }),
      characterContext
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(safeApiErrorSchema.parse(body).error.code).toBe(
      "invalid_character_url"
    );
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(exclusionCalls).toEqual([]);
  });

  it("refuses an exclusion the service cannot parse", async () => {
    exclusion = { kind: "invalid", code: "invalid_character_url" };

    const response = await PATCH(
      request("PATCH", { characterUrl, excluded: true }),
      characterContext
    );

    expect(response.status).toBe(400);
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      "invalid_character_url"
    );
  });
});

describe("DELETE /api/dossiers/:region/:realm/:name/connected-characters", () => {
  it("unlinks the named character", async () => {
    const response = await DELETE(
      request("DELETE", { characterUrl }),
      characterContext
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: "ready" });
    expect(removalCalls).toEqual([
      {
        root: { region: "eu", realm: "silvermoon", name: "ryii" },
        input: { characterUrl }
      }
    ]);
  });

  it("reports a link another reviewer has already removed", async () => {
    removal = { kind: "missing" };

    const response = await DELETE(
      request("DELETE", { characterUrl }),
      characterContext
    );

    expect(response.status).toBe(404);
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      "connection_not_found"
    );
  });

  it("refuses a non-canonical identity rather than unlinking under it", async () => {
    // The dossier identity in the path decides which links are touched, so an
    // identity the route did not canonicalise must remove nothing.
    const response = await DELETE(request("DELETE", { characterUrl }), {
      params: Promise.resolve({
        region: "EU",
        realm: "Silvermoon",
        name: "Ryii"
      })
    });

    expect(response.status).toBe(400);
    expect(removalCalls).toEqual([]);
  });
});
