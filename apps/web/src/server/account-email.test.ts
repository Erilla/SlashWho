import { describe, expect, it } from "vitest";
import { canonicalizeEmail, registrationSubjects } from "./account-email";

describe("canonicalizeEmail", () => {
  it("trims and folds ASCII email case", () => {
    expect(canonicalizeEmail("  Person@Example.COM ")).toBe(
      "person@example.com"
    );
  });

  it("rejects malformed, non-ASCII, and oversized addresses", () => {
    expect(canonicalizeEmail("bad@@example.com")).toBeNull();
    expect(canonicalizeEmail("person@-example.com")).toBeNull();
    expect(canonicalizeEmail("person@example-.com")).toBeNull();
    expect(canonicalizeEmail("pérson@example.com")).toBeNull();
    expect(canonicalizeEmail(`${"a".repeat(243)}@example.com`)).toBeNull();
  });

  it("rejects empty local-part dot segments", () => {
    expect(canonicalizeEmail("a..b@example.com")).toBeNull();
    expect(canonicalizeEmail(".alice@example.com")).toBeNull();
    expect(canonicalizeEmail("alice.@example.com")).toBeNull();
    expect(canonicalizeEmail("alice.bob@example.com")).toBe(
      "alice.bob@example.com"
    );
  });
});

describe("registrationSubjects", () => {
  const secret = "test-rate-limit-secret";
  const canonicalEmail = "person@example.com";
  const subjects = (headers: Record<string, string>) =>
    registrationSubjects(
      new Request("https://slashwho.example/register", { headers }),
      canonicalEmail,
      secret
    );

  it("uses a validated X-Real-IP and ignores X-Forwarded-For", () => {
    const trusted = subjects({
      "x-real-ip": "203.0.113.8",
      "x-forwarded-for": "198.51.100.1"
    });
    expect(trusted.ipSubjectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(trusted.emailSubjectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      subjects({
        "x-real-ip": "203.0.113.8",
        "x-forwarded-for": "198.51.100.2"
      })
    ).toEqual(trusted);
    expect(subjects({ "x-real-ip": "203.0.113.9" }).ipSubjectHash).not.toBe(
      trusted.ipSubjectHash
    );
    expect(
      subjects({ "x-forwarded-for": "203.0.113.8" }).ipSubjectHash
    ).toBeNull();
    expect(
      subjects({ "x-real-ip": "invalid", "x-forwarded-for": "203.0.113.8" })
        .ipSubjectHash
    ).toBeNull();
  });
});
