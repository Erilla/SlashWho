import { describe, expect, it } from "vitest";

import {
  integerInRange,
  optionalHttpUrl,
  parseDatabaseUrl,
  positiveInteger,
  positiveNumber,
  requiredPositiveInteger,
  requiredSecret
} from "./environment";

describe("environment primitives", () => {
  it.each([undefined, "", "   "])(
    "treats %j as unset rather than as zero",
    (value) => {
      // Break caught (#569): the web read a blank value as unset and the
      // worker read it as 0, so one environment booted one service and
      // crashed the other.
      expect(positiveInteger(value, 7, "invalid")).toBe(7);
      expect(positiveNumber(value, 1.5, "invalid")).toBe(1.5);
      expect(integerInRange(value, 3, 0, 5, "invalid")).toBe(3);
      expect(optionalHttpUrl(value, "invalid")).toBeUndefined();
    }
  );

  it.each(["0", "-1", "1.5", "ten", "9007199254740993"])(
    "rejects %s as a positive integer",
    (value) => {
      expect(() => positiveInteger(value, 7, "invalid_limit")).toThrow(
        "invalid_limit"
      );
    }
  );

  it("accepts a fractional positive number but not zero", () => {
    expect(positiveNumber("1.5", 24, "invalid_hours")).toBe(1.5);
    expect(() => positiveNumber("0", 24, "invalid_hours")).toThrow(
      "invalid_hours"
    );
    expect(() => positiveNumber("Infinity", 24, "invalid_hours")).toThrow(
      "invalid_hours"
    );
  });

  it("reports a missing required limit as required, not as invalid", () => {
    // Break caught (#569): a fallback of 0 made an unset variable fail its
    // own range check, so a deploy that forgot it was told it was invalid.
    expect(() =>
      requiredPositiveInteger(undefined, "cap_required", "invalid_cap")
    ).toThrow("cap_required");
    expect(() =>
      requiredPositiveInteger("", "cap_required", "invalid_cap")
    ).toThrow("cap_required");
    expect(() =>
      requiredPositiveInteger("0", "cap_required", "invalid_cap")
    ).toThrow("invalid_cap");
    expect(
      requiredPositiveInteger(" 300 ", "cap_required", "invalid_cap")
    ).toBe(300);
  });

  it("trims a required secret and rejects a blank one", () => {
    expect(requiredSecret(" id ", "id_required")).toBe("id");
    expect(() => requiredSecret("  ", "id_required")).toThrow("id_required");
  });

  it("accepts only a PostgreSQL database URL", () => {
    expect(parseDatabaseUrl("postgres://db/slashwho")).toBe(
      "postgres://db/slashwho"
    );
    expect(() => parseDatabaseUrl(undefined)).toThrow("database_url_required");
    expect(() => parseDatabaseUrl("mysql://db/slashwho")).toThrow(
      "invalid_database_url"
    );
    expect(() => parseDatabaseUrl("not a url")).toThrow("invalid_database_url");
  });

  it("accepts only an HTTP or HTTPS URL", () => {
    expect(optionalHttpUrl(" https://example.test ", "invalid_url")).toBe(
      "https://example.test"
    );
    expect(() => optionalHttpUrl("ftp://example.test", "invalid_url")).toThrow(
      "invalid_url"
    );
  });
});
