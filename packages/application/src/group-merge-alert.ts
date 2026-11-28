import type { CharacterGroupMerge } from "@slashwho/database";
import type { FingerprintAlertNotifier } from "./discovery-job-handler";

/** Called only after recompute transactions commit; alert failures cannot undo publication. */
export async function notifyGroupMerges(
  notifier: FingerprintAlertNotifier | undefined,
  merges: readonly CharacterGroupMerge[]
): Promise<void> {
  if (!notifier) return;
  for (const merge of merges) {
    if (!merge.throughObserved) continue;
    const details: Record<string, number> = { groups: merge.groupSizes.length };
    merge.groupSizes.forEach((size, index) => {
      details[`group${index + 1}Size`] = size;
    });
    for (const source of merge.sources) details[`${source}Present`] = 1;
    try {
      await notifier.notify({ event: "character_groups_merged", details });
    } catch {
      /* Best effort. */
    }
  }
}
