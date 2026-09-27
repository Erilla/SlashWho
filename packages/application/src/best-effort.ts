/**
 * Runs work whose failure must never fail the job around it -- announcing a
 * run, recording what it cost -- and reports a failure through `onFailure`
 * instead of throwing. The error itself is not handed on: these records are
 * kept free of message text, and a caller that wants the cause can log it
 * through `errorFields`.
 */
export async function bestEffort(
  work: () => unknown,
  onFailure?: () => void
): Promise<void> {
  try {
    await work();
  } catch {
    onFailure?.();
  }
}
