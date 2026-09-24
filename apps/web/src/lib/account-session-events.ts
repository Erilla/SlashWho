export const accountSessionChangedEvent = "slashwho:account-session-changed";

/** Refresh the persistent header after an account session changes. */
export function notifyAccountSessionChanged(): void {
  window.dispatchEvent(new Event(accountSessionChangedEvent));
}
