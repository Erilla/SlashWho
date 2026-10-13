import { describe, expect, it } from "vitest";
import { createDiscoveryJobPollSchedule } from "./discovery-job-poll-schedule";

describe("discovery job schedule", () => {
  it("keeps asks no more than two seconds apart through the fast window", () => {
    let now = 0;
    const schedule = createDiscoveryJobPollSchedule(() => now);
    expect(schedule.next()).toBe(1_000);
    now = 1_000;
    while (now < 90_000) {
      expect(schedule.next()).toBe(2_000);
      now += 2_000;
    }
    expect(schedule.next()).toBe(4_000);
    expect(schedule.next()).toBe(8_000);
    expect(schedule.next()).toBe(10_000);
    expect(schedule.next()).toBe(10_000);
  });
  it("counts hidden time rather than restarting the fast window", () => {
    let now = 0;
    const schedule = createDiscoveryJobPollSchedule(() => now);
    schedule.next();
    now = 120_000;
    expect(schedule.next()).toBe(4_000);
    expect(schedule.next()).toBe(8_000);
  });
});
