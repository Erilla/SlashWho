/**
 * Milliseconds a job waited between enqueue and execution, or null when the
 * job predates this field. Never negative, so clock skew reads as zero wait.
 */
export function queueWaitMs(
  enqueuedAt: string | undefined,
  startedAt: Date
): number | null {
  if (!enqueuedAt) return null;
  const queuedAt = Date.parse(enqueuedAt);
  if (!Number.isFinite(queuedAt)) return null;
  return Math.max(0, Math.round(startedAt.getTime() - queuedAt));
}
