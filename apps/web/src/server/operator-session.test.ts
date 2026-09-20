import type { ApplicationConfig } from "@slashwho/application";
import { describe, expect, it } from "vitest";

import {
  clearOperatorSessionCookie,
  createOperatorSessionCookie,
  isOperatorRequest,
  operatorSessionCookieName,
  operatorSessionTtlSeconds
} from "./operator-session";

const operatorKey = "operator-secret-that-is-at-least-32-characters";
const config: ApplicationConfig = {
  BOT_API_KEY: operatorKey,
  RATE_LIMIT_HASH_SECRET: "rate-limit-secret-that-is-32-chars",
  ANONYMOUS_SEARCHES_PER_HOUR: 10,
  BOT_SEARCHES_PER_HOUR: 60,
  PUBLIC_READS_PER_MINUTE: 300,
  FRESHNESS_HOURS: 24,
  DOSSIER_CHARACTER_CAP: 12,
  DOSSIER_PROVIDER_CONCURRENCY: 4,
  NEGATIVE_CACHE_TTL_MS: 300_000
};
const issuedAt = new Date("2026-09-21T08:00:00.000Z");

function sessionValue(setCookie: string): string {
  return setCookie.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));
}

describe("operator session", () => {
  it("exchanges the configured key for a short-lived hardened cookie", () => {
    const cookie = createOperatorSessionCookie(operatorKey, config, {
      now: issuedAt,
      nonce: Buffer.alloc(18, 7)
    });

    expect(cookie).toMatch(
      new RegExp(
        `^${operatorSessionCookieName}=[A-Za-z0-9._-]+; Path=/; Max-Age=${operatorSessionTtlSeconds}; HttpOnly; Secure; SameSite=Strict$`
      )
    );
    expect(cookie).not.toContain(operatorKey);
    expect(operatorSessionTtlSeconds).toBe(30 * 60);
  });

  it("does not issue a session for an invalid key", () => {
    expect(
      createOperatorSessionCookie("not-the-operator-key", config, {
        now: issuedAt,
        nonce: Buffer.alloc(18, 7)
      })
    ).toBeNull();
  });

  it("accepts a valid session until its fixed expiry", () => {
    const setCookie = createOperatorSessionCookie(operatorKey, config, {
      now: issuedAt,
      nonce: Buffer.alloc(18, 7)
    });
    if (setCookie === null) throw new Error("session_not_issued");
    const headers = new Headers({
      cookie: `${operatorSessionCookieName}=${sessionValue(setCookie)}`,
      "x-real-ip": "203.0.113.8"
    });

    expect(
      isOperatorRequest(headers, config, {
        now: new Date("2026-09-21T08:29:59.999Z")
      })
    ).toBe(true);
    expect(
      isOperatorRequest(headers, config, {
        now: new Date("2026-09-21T08:30:00.000Z")
      })
    ).toBe(false);
  });

  it("rejects tampered, duplicated, and key-rotation-invalidated sessions", () => {
    const setCookie = createOperatorSessionCookie(operatorKey, config, {
      now: issuedAt,
      nonce: Buffer.alloc(18, 7)
    });
    if (setCookie === null) throw new Error("session_not_issued");
    const value = sessionValue(setCookie);
    const rotatedConfig = { ...config, BOT_API_KEY: "r".repeat(40) };
    const at = new Date("2026-09-21T08:05:00.000Z");

    expect(
      isOperatorRequest(
        new Headers({
          cookie: `${operatorSessionCookieName}=${value.slice(0, -1)}x`
        }),
        config,
        { now: at }
      )
    ).toBe(false);
    expect(
      isOperatorRequest(
        new Headers({
          cookie: `${operatorSessionCookieName}=${value}; ${operatorSessionCookieName}=${value}`
        }),
        config,
        { now: at }
      )
    ).toBe(false);
    expect(
      isOperatorRequest(
        new Headers({ cookie: `${operatorSessionCookieName}=${value}` }),
        rotatedConfig,
        { now: at }
      )
    ).toBe(false);
  });

  it("retains Bearer automation and never falls back from an invalid Bearer to a cookie", () => {
    const setCookie = createOperatorSessionCookie(operatorKey, config, {
      now: issuedAt,
      nonce: Buffer.alloc(18, 7)
    });
    if (setCookie === null) throw new Error("session_not_issued");
    const cookie = `${operatorSessionCookieName}=${sessionValue(setCookie)}`;

    expect(
      isOperatorRequest(
        new Headers({ authorization: `Bearer ${operatorKey}` }),
        config,
        { now: issuedAt }
      )
    ).toBe(true);
    expect(
      isOperatorRequest(
        new Headers({
          authorization: `Bearer ${"x".repeat(40)}`,
          cookie
        }),
        config,
        { now: issuedAt }
      )
    ).toBe(false);
  });

  it("clears the host-only cookie with the same security attributes", () => {
    expect(clearOperatorSessionCookie()).toBe(
      `${operatorSessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
    );
  });
});
