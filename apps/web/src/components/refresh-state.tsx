import type { DiscoveryRunStatus, SnapshotState } from "@slashwho/contracts";

type RefreshStateProps = Readonly<{
  state: DiscoveryRunStatus | SnapshotState;
}>;

const labels: Record<DiscoveryRunStatus | SnapshotState, string> = {
  queued: "Queued",
  running: "Refreshing",
  retrying: "Retrying",
  complete: "Complete",
  partial: "Partial",
  failed: "Failed"
};

export function RefreshState({ state }: RefreshStateProps) {
  return (
    <span className="state-badge" data-state={state}>
      {labels[state]}
    </span>
  );
}
