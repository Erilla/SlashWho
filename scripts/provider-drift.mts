import { readdirSync, readFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  blizzard,
  parseTarget,
  raiderIo,
  TargetError,
  type Fetched,
  type FetchTarget,
  type Target
} from "./provider-fetch.mts";
import {
  PlaceholderBook,
  recordPayload,
  RecordingRefused,
  shapeOf,
  unreadPaths,
  type Endpoint,
  type Provider,
  type Recording
} from "./recorded-payloads.mts";

/**
 * Re-reads the recorded Blizzard and Raider.IO endpoints live and compares
 * their shape with the committed recordings in `tests/fixtures/recorded/`
 * (#599). A scheduled, out-of-band check (`.github/workflows/provider-drift.yml`),
 * never part of the pull-request gate.
 *
 * Drift is tiered:
 *
 * - **Fields we read** are the allow-list's paths. A changed status, a value
 *   the allow-list cannot classify, a `path: kind` no recording of the
 *   endpoint has shown, or one the probe's own recording shows that is now
 *   missing, fails the check.
 * - **Fields we ignore** are compared with the recording's `ignored` roots.
 *   A change there is only a warning.
 *
 * The report carries endpoints, scenario labels, statuses, field paths and
 * value kinds. It never carries a value, a target or a request URL: live
 * bodies are projected through the same redaction as a recording before any
 * comparison, and unread paths hold field names only.
 */

const recordedRoot = resolve(import.meta.dirname, "../tests/fixtures/recorded");

export type LabelledRecording = Readonly<{
  label: string;
  recording: Recording;
}>;

export type ProbeOutcome =
  "unchanged" | "ignored-drift" | "read-drift" | "unbaselined" | "inconclusive";

export type ProbeResult = Readonly<{
  endpoint: Endpoint;
  label: string;
  outcome: ProbeOutcome;
  liveStatus: number | null;
  recordedStatus: number | null;
  /** Changes to fields we read: each fails the check. */
  read: readonly string[];
  /** Changes to fields we ignore: warnings only. */
  ignored: readonly string[];
  notes: readonly string[];
}>;

export type ProbeInput = Readonly<{
  endpoint: Endpoint;
  label: string;
  /** A live response, or the fixed code of a request that never completed. */
  live: Fetched | Readonly<{ error: string }>;
}>;

export function loadRecordings(root = recordedRoot): LabelledRecording[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const recording = JSON.parse(
        readFileSync(resolve(entry.parentPath, entry.name), "utf8")
      ) as Recording;
      const prefix = `${recording.endpoint.split(".")[1]!}-`;
      return {
        label: basename(entry.name, ".json").slice(prefix.length),
        recording
      };
    });
}

const isSuccess = (status: number) => status >= 200 && status < 300;
const isInconclusive = (status: number) => status === 429 || status >= 500;

function difference(
  left: ReadonlySet<string> | readonly string[],
  right: ReadonlySet<string> | readonly string[]
): string[] {
  const exclude = new Set(right);
  return [...left].filter((entry) => !exclude.has(entry)).sort();
}

/**
 * An unread path is built from field names, but a field name could in
 * principle be data. Any segment matching an identity this probe's redaction
 * replaced is folded, so the report cannot carry one even then.
 */
function withoutIdentities(
  paths: readonly string[],
  book: PlaceholderBook
): readonly string[] {
  const replaced = new Set(
    book.replacedValues().map((value) => value.toLocaleLowerCase("en-US"))
  );
  const folded = paths.map((path) =>
    path
      .split(".")
      .map((segment) => {
        const key = segment.replace(/(?:\[\])+$/, "");
        return replaced.has(key.toLocaleLowerCase("en-US"))
          ? `<key>${segment.slice(key.length)}`
          : segment;
      })
      .join(".")
  );
  return [...new Set(folded)].sort();
}

export function compareProbe(
  input: ProbeInput,
  recordings: readonly LabelledRecording[],
  recordedOn: string
): ProbeResult {
  const { endpoint, label } = input;
  const baseline = recordings.find(
    (entry) => entry.recording.endpoint === endpoint && entry.label === label
  )?.recording;
  const recordedStatus = baseline?.status ?? null;
  const result = (
    outcome: ProbeOutcome,
    liveStatus: number | null,
    fields: Partial<Pick<ProbeResult, "read" | "ignored" | "notes">> = {}
  ): ProbeResult => ({
    endpoint,
    label,
    outcome,
    liveStatus,
    recordedStatus,
    read: fields.read ?? [],
    ignored: fields.ignored ?? [],
    notes: fields.notes ?? []
  });

  if ("error" in input.live)
    return result("inconclusive", null, {
      notes: [`request did not complete: ${input.live.error}`]
    });

  const { status, body } = input.live;
  // A throttle or an outage says nothing about shape, unless it is the very
  // answer the probe recorded.
  if (isInconclusive(status) && status !== recordedStatus)
    return result("inconclusive", status, {
      notes: ["upstream throttled or failed; shape not compared"]
    });

  const read: string[] = [];
  const notes: string[] = [];
  if (recordedStatus !== null && recordedStatus !== status)
    read.push(`status ${String(recordedStatus)} is now ${String(status)}`);

  const book = new PlaceholderBook();
  let live: Recording;
  try {
    live = recordPayload(body, { endpoint, status, recordedOn, book });
  } catch (error) {
    if (!(error instanceof RecordingRefused)) throw error;
    // The refusal's message is its reason and path; its value is never read.
    read.push(`cannot classify: ${error.message}`);
    return result("read-drift", status, { read, notes });
  }

  const sameClass = recordings.filter(
    (entry) =>
      entry.recording.endpoint === endpoint &&
      isSuccess(entry.recording.status) === isSuccess(status)
  );
  const liveShape = shapeOf(live.body);
  if (sameClass.length === 0) {
    notes.push(
      `no recording of ${endpoint} with a ${isSuccess(status) ? "success" : "error"} status to compare with; record one`
    );
  } else {
    const observed = new Set<string>();
    for (const entry of sameClass)
      for (const kind of shapeOf(entry.recording.body)) observed.add(kind);
    for (const added of difference(liveShape, observed))
      read.push(`+ ${added} (no recording shows it)`);
  }

  const sameStatusBaseline = baseline?.status === status ? baseline : null;
  if (sameStatusBaseline) {
    for (const removed of difference(
      shapeOf(sameStatusBaseline.body),
      liveShape
    ))
      read.push(`- ${removed} (recorded, now missing)`);
  }
  if (!baseline) notes.push(`no recording labelled ${label}; record one`);

  const ignored: string[] = [];
  if (sameStatusBaseline?.ignored) {
    const liveUnread = withoutIdentities(
      unreadPaths(body, endpoint, status),
      book
    );
    for (const added of difference(liveUnread, sameStatusBaseline.ignored))
      ignored.push(`+ ${added}`);
    for (const removed of difference(sameStatusBaseline.ignored, liveUnread))
      ignored.push(`- ${removed}`);
  } else if (sameStatusBaseline) {
    notes.push(
      "the recording predates its ignored-field baseline; re-record it to compare fields we ignore"
    );
  }

  const outcome: ProbeOutcome =
    read.length > 0
      ? "read-drift"
      : !baseline || sameClass.length === 0
        ? "unbaselined"
        : ignored.length > 0
          ? "ignored-drift"
          : "unchanged";
  return result(outcome, status, { read, ignored, notes });
}

/** 1 when a field we read drifted, 3 when a probe was inconclusive, else 0. */
export function exitCode(results: readonly ProbeResult[]): number {
  if (results.some((result) => result.outcome === "read-drift")) return 1;
  if (results.some((result) => result.outcome === "inconclusive")) return 3;
  return 0;
}

const outcomeLabels: Readonly<Record<ProbeOutcome, string>> = {
  unchanged: "unchanged",
  "ignored-drift": "warning: fields we ignore changed",
  "read-drift": "**drift in fields we read**",
  unbaselined: "warning: not fully baselined",
  inconclusive: "inconclusive"
};

const status = (value: number | null) =>
  value === null ? "none" : String(value);

export function renderReport(
  results: readonly ProbeResult[],
  checkedOn: string
): string {
  const lines = [
    `## Provider response-shape drift, ${checkedOn}`,
    "",
    "Live Blizzard and Raider.IO responses compared with `tests/fixtures/recorded/`. Paths and value kinds only; no values.",
    "",
    "| Probe | Live status | Recorded status | Outcome |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (result) =>
        `| \`${result.endpoint}:${result.label}\` | ${status(result.liveStatus)} | ${status(result.recordedStatus)} | ${outcomeLabels[result.outcome]} |`
    )
  ];
  for (const result of results) {
    if (
      result.read.length === 0 &&
      result.ignored.length === 0 &&
      result.notes.length === 0
    )
      continue;
    lines.push("", `### \`${result.endpoint}:${result.label}\``);
    if (result.read.length > 0)
      lines.push(
        "",
        "Fields we read:",
        "",
        ...result.read.map((entry) => `- \`${entry}\``)
      );
    if (result.ignored.length > 0)
      lines.push(
        "",
        "Fields we ignore:",
        "",
        ...result.ignored.map((entry) => `- \`${entry}\``)
      );
    if (result.notes.length > 0)
      lines.push("", ...result.notes.map((note) => `- ${note}`));
  }
  if (results.some((result) => result.outcome === "read-drift"))
    lines.push(
      "",
      "A parser may need to follow. If the probe's character itself changed (left a guild, removed a Discord handle), re-record its scenario instead; see `tests/fixtures/recorded/README.md`."
    );
  return `${lines.join("\n")}\n`;
}

// A thrown error's message is kept only when it is one of this codebase's
// fixed codes; anything else (a network error can name the host or path) is
// reported as a bare failure.
function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z_]*$/.test(error.message)
    ? error.message
    : "request_failed";
}

async function probe(
  fetchTarget: FetchTarget,
  target: Target,
  sleep: (milliseconds: number) => Promise<void>
): Promise<ProbeInput["live"]> {
  let live: ProbeInput["live"] = { error: "request_failed" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(10_000);
    try {
      live = await fetchTarget(target);
      if (!isInconclusive(live.status)) return live;
    } catch (error) {
      live = { error: errorCode(error) };
    }
  }
  return live;
}

export function targetsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): readonly Target[] {
  const variables: Readonly<Record<Provider, string>> = {
    raiderio: "PROVIDER_DRIFT_RAIDERIO_TARGETS",
    blizzard: "PROVIDER_DRIFT_BLIZZARD_TARGETS"
  };
  const targets = (Object.keys(variables) as Provider[]).flatMap((provider) =>
    (environment[variables[provider]] ?? "")
      .split(/\s+/)
      .filter((value) => value.length > 0)
      .map((value) => parseTarget(provider, value))
  );
  if (targets.length === 0)
    throw new TargetError("no drift targets configured");
  return targets;
}

async function main(): Promise<number> {
  const targets = targetsFromEnvironment(process.env);
  const recordings = loadRecordings();
  const today = new Date().toISOString().slice(0, 10);
  const fetchers: Partial<Record<Provider, FetchTarget>> = {};
  const sleep = (milliseconds: number) =>
    new Promise<void>((done) => setTimeout(done, milliseconds));

  const results: ProbeResult[] = [];
  for (const target of targets) {
    const provider = target.endpoint.split(".")[0] as Provider;
    const fetchTarget = (fetchers[provider] ??=
      provider === "raiderio" ? raiderIo() : blizzard());
    results.push(
      compareProbe(
        {
          endpoint: target.endpoint,
          label: target.label,
          live: await probe(fetchTarget, target, sleep)
        },
        recordings,
        today
      )
    );
  }

  const report = renderReport(results, today);
  process.stdout.write(report);
  const reportPath = process.env.PROVIDER_DRIFT_REPORT?.trim();
  if (reportPath) await writeFile(reportPath, report, "utf8");
  const summaryPath = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (summaryPath) await appendFile(summaryPath, report, "utf8");
  return exitCode(results);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // A target error's message is fixed text that never quotes the target.
      process.stderr.write(
        `${error instanceof TargetError ? error.message : errorCode(error)}\n`
      );
      process.exitCode = 2;
    });
}
