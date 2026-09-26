// Built once: an Intl.DateTimeFormat is costly to construct, and these run for
// every row of a dossier. Every one is en-GB in UTC, so a date reads the same
// wherever the visitor is.

const utcDate = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC"
});

const utcDateTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC"
});

const utcMinute = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC"
});

/** "26 Sept 2026" for an ISO timestamp, on its UTC day. */
export function formatUtcDate(iso: string): string {
  return utcDate.format(new Date(iso));
}

/** "26 Sept 2026, 14:05:09", in UTC. */
export function formatUtcDateTime(iso: string): string {
  return utcDateTime.format(new Date(iso));
}

/** "26 Sept 2026, 14:05", in UTC, to the minute. */
export function formatUtcMinute(iso: string): string {
  return utcMinute.format(new Date(iso));
}
