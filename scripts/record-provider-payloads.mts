import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  leakedIdentities,
  PlaceholderBook,
  recordPayload,
  RecordingRefused,
  verifyRecording,
  type Provider,
  type Recording
} from "./recorded-payloads.mts";
import {
  blizzard,
  parseTarget,
  raiderIo,
  TargetError,
  type Target
} from "./provider-fetch.mts";

/**
 * Records live Blizzard or Raider.IO responses as redacted fixtures under
 * `tests/fixtures/recorded/`. An out-of-band step run by a maintainer, never by
 * the pull-request gate; see `tests/fixtures/recorded/README.md`.
 *
 *   corepack pnpm exec tsx --env-file-if-exists=.env scripts/record-provider-payloads.mts raiderio character:no-guild=eu/silvermoon/name
 *   corepack pnpm exec tsx --env-file-if-exists=.env scripts/record-provider-payloads.mts blizzard guild-roster:root-guild=eu/argent-dawn/name
 *
 * Each target is `<endpoint>:<label>=<target>`. The label names the output
 * file, so it must describe the scenario, never the character. Targets are
 * read from the command line only and are never written or printed: output is
 * the file name and the status. Every recording is projected through the
 * allow-list, checked for any real identity it replaced, and verified before
 * anything is written; one failure writes nothing.
 */

const outputRoot = resolve(import.meta.dirname, "../tests/fixtures/recorded");

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: record-provider-payloads.mts <raiderio|blizzard> <endpoint>:<label>=<target>... [--show-unrecognised]\n`
  );
  process.exit(2);
}

function targetOrUsage(provider: Provider, value: string): Target {
  try {
    return parseTarget(provider, value);
  } catch (error) {
    if (error instanceof TargetError) usage(error.message);
    throw error;
  }
}

function outputPath(recording: Recording, label: string): string {
  const [provider, endpoint] = recording.endpoint.split(".");
  return resolve(outputRoot, provider!, `${endpoint}-${label}.json`);
}

async function main() {
  const args = process.argv.slice(2);
  const showUnrecognised = args.includes("--show-unrecognised");
  const [provider, ...rawTargets] = args.filter(
    (arg) => arg !== "--show-unrecognised"
  );
  if (provider !== "raiderio" && provider !== "blizzard")
    usage("provider must be raiderio or blizzard");
  if (rawTargets.length === 0) usage("at least one target is required");
  const targets = rawTargets.map((value) => targetOrUsage(provider, value));

  const fetchTarget = provider === "raiderio" ? raiderIo() : blizzard();
  const book = new PlaceholderBook();
  const recordedOn = new Date().toISOString().slice(0, 10);
  const pending: { path: string; serialised: string }[] = [];

  for (const target of targets) {
    const { status, body } = await fetchTarget(target);
    let recording: Recording;
    try {
      recording = recordPayload(body, {
        endpoint: target.endpoint,
        status,
        recordedOn,
        book
      });
    } catch (error) {
      if (!(error instanceof RecordingRefused)) throw error;
      // The value is shown only when asked for, and only on this terminal: it
      // is the upstream text the allow-list has not yet reviewed.
      const shown =
        showUnrecognised && error.value !== undefined
          ? ` (value: ${JSON.stringify(error.value)})`
          : "";
      // Reported and exited rather than rethrown: an uncaught error would
      // print the refusal's properties, including the unreviewed value.
      process.stderr.write(
        `${target.endpoint}:${target.label} status ${String(status)}: ${error.message}${shown}
`
      );
      process.exit(1);
    }
    const violations = verifyRecording(recording);
    if (violations.length > 0)
      throw new Error(
        `${target.endpoint}:${target.label} failed verification: ${violations.map((v) => `${v.path} ${v.problem}`).join("; ")}`
      );
    pending.push({
      path: outputPath(recording, target.label),
      serialised: `${JSON.stringify(recording, null, 2)}\n`
    });
    process.stdout.write(
      `recorded ${target.endpoint}:${target.label} (status ${String(status)})\n`
    );
  }

  // Checked only once every target is recorded: a name replaced in a later
  // file must not survive in an earlier one.
  for (const { path, serialised } of pending) {
    if (leakedIdentities(serialised, book).length > 0)
      throw new Error(`refusing to write ${path}: a real identity survived`);
  }
  for (const { path, serialised } of pending) {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, serialised, "utf8");
    process.stdout.write(`wrote ${path}\n`);
  }
}

await main();
