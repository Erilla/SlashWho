/**
 * Loads the Blizzard response fixtures in tests/fixtures/blizzard/. Test
 * support only: nothing outside the package's tests imports it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type FixtureName =
  | "token-valid"
  | "token-empty-access-token"
  | "token-forbidden"
  | "profile-guild"
  | "profile-guild-other-realm"
  | "profile-guild-empty-name"
  | "profile-guild-empty-realm-slug"
  | "profile-without-guild"
  | "profile-forbidden"
  | "profile-missing"
  | "playable-class-index"
  | "playable-class-index-renamed"
  | "playable-class-index-empty-name"
  | "playable-class-index-forbidden"
  | "guild-roster"
  | "guild-roster-member-empty-name"
  | "guild-roster-member-empty-realm-slug"
  | "guild-roster-member-without-playable-class"
  | "guild-roster-without-members"
  | "guild-roster-forbidden"
  | "guild-roster-missing"
  | "achievements-completed"
  | "achievements-empty"
  | "achievements-with-unfinished"
  | "achievements-non-numeric-pairs"
  | "achievements-malformed-timestamp"
  | "achievements-without-achievements"
  | "achievements-forbidden"
  | "achievements-missing"
  | "achievements-rate-limited"
  | "achievements-rate-limited-no-retry-after";

export type Fixture = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export const fixtureDirectory = fileURLToPath(
  new URL("../../../tests/fixtures/blizzard/", import.meta.url)
);

export function readFixture(name: FixtureName): Fixture {
  return JSON.parse(
    readFileSync(resolve(fixtureDirectory, `${name}.json`), "utf8")
  ) as Fixture;
}

/**
 * Builds a fresh response from a fixture. `bodyText` replaces the fixture's
 * body with a test marker, which is a test input rather than a Blizzard shape.
 */
export function fixtureResponse(
  name: FixtureName,
  options: { bodyText?: string } = {}
): Response {
  const fixture = readFixture(name);
  const body =
    options.bodyText ??
    (fixture.body === undefined ? null : JSON.stringify(fixture.body));
  return new Response(body, {
    status: fixture.status,
    headers: {
      ...(fixture.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...fixture.headers
    }
  });
}
