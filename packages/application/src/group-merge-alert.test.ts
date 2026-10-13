import { expect, it } from "vitest";
import { notifyGroupMerges } from "./group-merge-alert";
it("alerts on observed bridges but keeps manual-only merges in the log", async () => {
  const events: unknown[] = [];
  await notifyGroupMerges(
    {
      notify: async (alert) => {
        events.push(alert);
      }
    },
    [
      { groupSizes: [2, 3], sources: ["fingerprint"], throughObserved: true },
      { groupSizes: [4, 5], sources: [], throughObserved: false }
    ]
  );
  expect(events).toEqual([
    {
      event: "character_groups_merged",
      details: { groups: 2, group1Size: 2, group2Size: 3, fingerprint: 1 }
    }
  ]);
});
