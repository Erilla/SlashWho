import { describe, expect, it } from "vitest";
import { chooseApplicationRow, type IntakeRow } from "./applicant-applications";

const x = 'character:["eu","hyjal","tropipe"]';
const y = 'character:["eu","hyjal","tropicos"]';
const row = (
  n: number,
  serial: number | undefined,
  ...identities: string[]
): IntakeRow => ({
  row: n,
  submittedSerial: serial,
  identities
});

describe("chooseApplicationRow", () => {
  it("chooses the one new row whose first link is the identity", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, 10, y, x), row(3, 20, x, y)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: undefined
      })
    ).toEqual({ row: row(3, 20, x, y), ambiguous: 0 });
  });

  it("chooses by serial, not position, after a sort", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, 20, x, y), row(3, 10, x)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: undefined
      }).row?.submittedSerial
    ).toBe(20);
  });

  it("records nothing when the identity is new only as a reference", () => {
    // Break caught: a pre-mark row whose first link later appeared as a
    // reference in someone else's row became a backfilled application.
    expect(
      chooseApplicationRow({
        rows: [row(2, 5, x, y), row(3, 20, y, x)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: undefined
      })
    ).toEqual({ row: undefined, ambiguous: 0 });
  });

  it("ignores rows no newer than the identity's last application", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, 20, x, y)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: 20
      }).row
    ).toBeUndefined();
  });

  it("takes the newest of several and counts the rest", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, 20, x), row(3, 30, x, y)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: undefined
      })
    ).toEqual({ row: row(3, 30, x, y), ambiguous: 1 });
  });

  it("never chooses a row without a serial", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, undefined, x, y)],
        rootIdentity: x,
        carriedMark: 0,
        lastApplicationSerial: undefined
      }).row
    ).toBeUndefined();
  });
});
