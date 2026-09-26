import { expect, it } from "vitest";

import {
  formatUtcDate,
  formatUtcDateTime,
  formatUtcMinute
} from "./date-format";

// Late on the 26th in UTC is already the 27th east of it, so each formatter
// has to hold the UTC day.
const lateUtc = "2026-09-26T23:30:15.000Z";

it("formats in en-GB on the UTC day", () => {
  expect(formatUtcDate(lateUtc)).toBe("26 Sept 2026");
  expect(formatUtcDateTime(lateUtc)).toBe("26 Sept 2026, 23:30:15");
  expect(formatUtcMinute(lateUtc)).toBe("26 Sept 2026, 23:30");
});
