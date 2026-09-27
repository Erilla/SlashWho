import { test, type Browser } from "playwright/test";
import type { CharacterKey } from "@slashwho/domain";

import {
  formatLoadSummary,
  parseServerTiming,
  summariseLoads,
  type LoadSample
} from "../e2e/support/load-profile";
import { seedCharacterEvidence, seedSnapshot } from "../e2e/support/seed";

/**
 * The dossier load profiler (#646): `corepack pnpm profile:dossier`. It runs
 * against the e2e global setup, so every provider is a local fake and no live
 * Raider.IO, Blizzard or Warcraft Logs traffic is possible. It is not part of
 * `test:e2e` or CI; it measures, and asserts nothing about the numbers.
 *
 * PROFILE_LOADS sets how many loads each warm scenario takes (default 20).
 * PROFILE_PROVIDER_LATENCY_MS sets how long the fake Raider.IO and Blizzard
 * take to answer in the provider scenario (default 150).
 */
const loads = Math.max(1, Number(process.env.PROFILE_LOADS ?? 20) || 20);
const providerLatencyMs = Math.max(
  0,
  Number(process.env.PROFILE_PROVIDER_LATENCY_MS ?? 150) || 0
);
const settleTimeoutMs = 45_000;

/** Sets the fakes' answer delay; the e2e suite always runs them at 0. */
async function setProviderLatency(ms: number): Promise<void> {
  for (const variable of ["E2E_RAIDER_IO_BASE_URL", "E2E_BLIZZARD_BASE_URL"]) {
    const baseUrl = process.env[variable];
    if (!baseUrl) throw new Error(`profile_${variable.toLowerCase()}_missing`);
    const response = await fetch(
      new URL(`/__control/latency?ms=${ms}`, baseUrl)
    );
    if (!response.ok) throw new Error("profile_latency_control_failed");
  }
}

type PageMarks = {
  requestedMs?: number;
  headersMs?: number;
  firstResponseMs?: number;
  /** Every fetch the page started before its first dossier read. */
  prelude: { path: string; startMs: number; endMs?: number }[];
  renderedMs?: number;
  settledMs?: number;
  serverTiming: string | null;
  /** The latest full read's evidence states, reported if a load times out. */
  lastStates?: string[];
};

/**
 * Runs in the page before any of its scripts. It records, on the page's own
 * clock, when the first dossier read arrives, when the connected-characters
 * panel first appears and when a full read first shows nothing gathering.
 *
 * "Gathering" is `waiting` or `scanning`: a run not yet published. The page's
 * own poll also continues through `partial`, which can be final and then
 * never ends (#663), so settling on the page's rule would hang the profile.
 */
function instrumentDossierLoad(): void {
  const marks: PageMarks = { serverTiming: null, prelude: [] };
  (window as unknown as { __dossierLoad: PageMarks }).__dossierLoad = marks;

  type Character = { excluded?: boolean; evidenceState?: string };
  type Raid = { tierSearch?: { state?: string } | null };
  const gathering = (body: { characters?: Character[]; raids?: Raid[] }) =>
    (body.characters ?? []).some(
      (character) =>
        !character.excluded &&
        ["waiting", "scanning"].includes(character.evidenceState ?? "")
    ) ||
    (body.raids ?? []).some((raid) =>
      ["queued", "running"].includes(raid.tierSearch?.state ?? "")
    );

  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), window.location.href);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const dossierRead =
      method === "GET" &&
      /^\/api\/dossiers\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname);
    const startedAt = performance.now();
    const prelude: PageMarks["prelude"][number] | undefined =
      !dossierRead && marks.requestedMs === undefined
        ? { path: `${method} ${url.pathname}`, startMs: startedAt }
        : undefined;
    if (prelude) marks.prelude.push(prelude);
    if (dossierRead) marks.requestedMs ??= startedAt;
    const response = await original(input, init);
    if (prelude) prelude.endMs = performance.now();
    if (dossierRead) {
      marks.headersMs ??= performance.now();
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as Parameters<typeof gathering>[0] | null;
      const now = performance.now();
      if (body !== null && url.searchParams.get("scope") !== "initial") {
        marks.lastStates = (body.characters ?? []).map(
          (character) => character.evidenceState ?? "none"
        );
      }
      if (marks.firstResponseMs === undefined) {
        marks.firstResponseMs = now;
        marks.serverTiming = response.headers.get("server-timing");
      }
      if (
        response.ok &&
        body !== null &&
        url.searchParams.get("scope") !== "initial" &&
        marks.settledMs === undefined &&
        !gathering(body)
      ) {
        marks.settledMs = now;
      }
    }
    return response;
  };

  const observer = new MutationObserver(() => {
    if (document.getElementById("dossier-characters-heading")) {
      marks.renderedMs = performance.now();
      observer.disconnect();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

/** The most recent load's pre-read fetches, printed with each summary. */
let lastPrelude: PageMarks["prelude"] = [];

function formatPrelude(): string {
  if (lastPrelude.length === 0) return "  (no fetch before the first read)";
  return lastPrelude
    .map(
      ({ path, startMs, endMs }) =>
        `  before the first read: ${path} ${Math.round(startMs)}-${endMs === undefined ? "?" : Math.round(endMs)} ms`
    )
    .join("\n");
}

async function loadOnce(browser: Browser, path: string): Promise<LoadSample> {
  // A fresh context per load: no HTTP cache, no storage, no warm page.
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-real-ip": "127.0.0.1" }
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(instrumentDossierLoad);
    await page.goto(path);
    await page
      .waitForFunction(
        () => {
          const marks = (window as unknown as { __dossierLoad?: PageMarks })
            .__dossierLoad;
          return (
            marks?.renderedMs !== undefined && marks.settledMs !== undefined
          );
        },
        undefined,
        { timeout: settleTimeoutMs, polling: 100 }
      )
      .catch(async (error: unknown) => {
        const stuck = await page.evaluate(
          () =>
            (window as unknown as { __dossierLoad?: PageMarks }).__dossierLoad
        );
        throw new Error(
          `dossier_load_unsettled: ${path} ${JSON.stringify(stuck)}`,
          { cause: error }
        );
      });
    const { marks, shellMs } = await page.evaluate(() => {
      const navigation = performance.getEntriesByType(
        "navigation"
      )[0] as PerformanceNavigationTiming;
      return {
        marks: (window as unknown as { __dossierLoad: PageMarks })
          .__dossierLoad,
        shellMs: navigation.domContentLoadedEventEnd
      };
    });
    lastPrelude = marks.prelude;
    return {
      shellMs,
      ...(marks.requestedMs === undefined
        ? {}
        : { requestedMs: marks.requestedMs }),
      ...(marks.headersMs === undefined ? {} : { headersMs: marks.headersMs }),
      firstResponseMs: marks.firstResponseMs!,
      renderedMs: marks.renderedMs!,
      settledMs: marks.settledMs!,
      server: parseServerTiming(marks.serverTiming)
    };
  } finally {
    await context.close();
  }
}

function key(name: string): CharacterKey {
  return { region: "eu", realm: "silvermoon", name };
}

/** A letters-only suffix, because a character name cannot hold a digit. */
function suffix(index: number): string {
  return index
    .toString(26)
    .replace(/./g, (digit) => String.fromCharCode(97 + parseInt(digit, 26)));
}

function title(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

async function profile(
  browser: Browser,
  scenario: string,
  path: string,
  count: number
): Promise<void> {
  // One discarded load first, so the process's first-request costs (route
  // compilation into memory, pool connections, JIT) are not billed to the
  // scenario. It is reported separately because a visitor can hit it too.
  const warmUp = await loadOnce(browser, path);
  const samples: LoadSample[] = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(await loadOnce(browser, path));
  }
  console.log(
    `${formatLoadSummary(scenario, summariseLoads(samples))}\n${formatPrelude()}\n  (warm-up load: rendered ${Math.round(warmUp.renderedMs)} ms, settled ${Math.round(warmUp.settledMs ?? 0)} ms)\n`
  );
}

test.describe.configure({ mode: "serial" });

test("warm read of a single character", async ({ browser }) => {
  // A fresh snapshot and completed evidence: nothing to discover or gather.
  const root = key("profilesingle");
  await seedSnapshot({
    key: root,
    displayName: title(root.name),
    refreshedAt: new Date()
  });
  await seedCharacterEvidence(root);

  await profile(
    browser,
    "warm single",
    `/dossiers/eu/silvermoon/${root.name}`,
    loads
  );
});

test("warm read of a dossier at the character ceiling", async ({ browser }) => {
  // Twelve connected characters, the default DOSSIER_CHARACTER_CEILING, each
  // with completed evidence: the largest read the page makes.
  const root = key("profilewide");
  const characters = [
    root,
    ...Array.from({ length: 11 }, (_, index) =>
      key(`profilealt${suffix(index)}`)
    )
  ];
  await seedSnapshot({
    key: root,
    displayName: title(root.name),
    refreshedAt: new Date(),
    characters: characters.map((character) => ({
      key: character,
      displayName: title(character.name),
      className: "Mage",
      level: 80
    }))
  });
  for (const character of characters) await seedCharacterEvidence(character);

  await profile(
    browser,
    "warm at ceiling",
    `/dossiers/eu/silvermoon/${root.name}`,
    loads
  );
});

test("read that gathers Warcraft Logs evidence", async ({ browser }) => {
  // A fresh snapshot with no evidence, so the read queues an evidence run the
  // worker completes against the fake Warcraft Logs. Each load needs its own
  // character, because a completed run leaves the next read warm.
  const count = Math.max(1, Math.ceil(loads / 4));
  const samples: LoadSample[] = [];
  for (let index = 0; index <= count; index += 1) {
    const root = key(`profilegather${suffix(index)}`);
    await seedSnapshot({
      key: root,
      displayName: title(root.name),
      refreshedAt: new Date()
    });
    const sample = await loadOnce(
      browser,
      `/dossiers/eu/silvermoon/${root.name}`
    );
    // The first is the discarded warm-up, as in the warm scenarios.
    if (index > 0) samples.push(sample);
  }
  console.log(
    `${formatLoadSummary("gathering", summariseLoads(samples))}\n${formatPrelude()}\n`
  );
});

test("read that needs Blizzard and Raider.IO rankings", async ({ browser }) => {
  // Completed evidence whose kills carry no world rank and no stored Cutting
  // Edge, so the read looks up both from the fakes, each answering after
  // PROFILE_PROVIDER_LATENCY_MS. Every load gets its own character and guild,
  // because a lookup is cached per character (Blizzard) and per guild
  // (rankings), and a ranking lookup is recorded once made.
  const count = Math.max(1, Math.ceil(loads / 2));
  const samples: LoadSample[] = [];
  await setProviderLatency(providerLatencyMs);
  try {
    for (let index = 0; index <= count; index += 1) {
      const root = key(`profileranked${suffix(index)}`);
      await seedSnapshot({
        key: root,
        displayName: title(root.name),
        refreshedAt: new Date()
      });
      await seedCharacterEvidence(root, {
        guildName: `Profile${title(suffix(index))}`
      });
      const sample = await loadOnce(
        browser,
        `/dossiers/eu/silvermoon/${root.name}`
      );
      if (index > 0) samples.push(sample);
    }
  } finally {
    await setProviderLatency(0);
  }
  console.log(
    `${formatLoadSummary(`providers at ${providerLatencyMs} ms`, summariseLoads(samples))}\n${formatPrelude()}\n`
  );
});

test("cold read through discovery", async ({ browser }) => {
  // No snapshot at all: the read answers discovery_not_ready, the page starts
  // research, polls the job, then reads the dossier and waits for its
  // evidence. The fake Raider.IO declares nothing for these characters, so
  // discovery ends on the root. Each load needs a character never seen.
  const count = Math.max(1, Math.ceil(loads / 4));
  const samples: LoadSample[] = [];
  for (let index = 0; index <= count; index += 1) {
    const sample = await loadOnce(
      browser,
      `/dossiers/eu/silvermoon/profilecold${suffix(index)}`
    );
    if (index > 0) samples.push(sample);
  }
  console.log(
    `${formatLoadSummary("cold", summariseLoads(samples))}\n${formatPrelude()}\n`
  );
});
