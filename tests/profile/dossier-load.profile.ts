import { test, type APIRequestContext, type Browser } from "playwright/test";
import type { CharacterKey } from "@slashwho/domain";

import {
  credentialStorageKey,
  type StoredApiCredentials
} from "../../apps/web/src/lib/api-credentials";
import { earlyReadSlot } from "../../apps/web/src/lib/early-dossier-read";
import {
  findSessionCheck,
  formatLoadSummary,
  parseServerTiming,
  summariseLoads,
  type LoadSample,
  type PreludeFetch
} from "../e2e/support/load-profile";
import {
  seedCharacterEvidence,
  seedSnapshot,
  seedSyntheticEvidence
} from "../e2e/support/seed";
import type { EvidenceVolume } from "../e2e/support/synthetic-evidence";

/**
 * The dossier load profiler (#646): `corepack pnpm profile:dossier`. It runs
 * against the e2e global setup, so every provider is a local fake and no live
 * Raider.IO, Blizzard or Warcraft Logs traffic is possible. It is not part of
 * `test:e2e` or CI; it measures, and asserts nothing about the numbers.
 *
 * PROFILE_LOADS sets how many loads each warm scenario takes (default 20).
 * PROFILE_PROVIDER_LATENCY_MS sets how long the fake Raider.IO and Blizzard
 * take to answer in the provider scenarios (default 150).
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
  /** The shell's inline script left an early read for the client (#684). */
  earlyRead: boolean;
  /** The first dossier read carried provider keys saved in the browser. */
  keysSent: boolean;
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
 *
 * It also watches `slot`, where the shell's script leaves the read it started
 * early, and whether the first read carried keys saved in the browser.
 */
function instrumentDossierLoad(slot: string): void {
  const marks: PageMarks = {
    earlyRead: false,
    keysSent: false,
    serverTiming: null,
    prelude: []
  };
  (window as unknown as { __dossierLoad: PageMarks }).__dossierLoad = marks;

  // The client takes the early read with a read and a `delete`, so the slot
  // stays an ordinary configurable property apart from noting the write.
  let early: unknown;
  Object.defineProperty(window, slot, {
    configurable: true,
    get: () => early,
    set: (value: unknown) => {
      marks.earlyRead = true;
      early = value;
    }
  });

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
    const url = new URL(
      request?.url ?? (input instanceof URL ? input.href : (input as string)),
      window.location.href
    );
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
    if (dossierRead && marks.requestedMs === undefined) {
      marks.requestedMs = startedAt;
      const headers = new Headers(init?.headers ?? request?.headers);
      marks.keysSent = [
        "x-blizzard-client-id",
        "x-raiderio-access-key",
        "x-wcl-client-id"
      ].some((name) => headers.has(name));
    }
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
let lastPrelude: readonly PreludeFetch[] = [];

function formatPrelude(): string {
  if (lastPrelude.length === 0) return "  (no fetch before the first read)";
  return lastPrelude
    .map(
      ({ path, startMs, endMs }) =>
        `  before the first read: ${path} ${Math.round(startMs)}-${endMs === undefined ? "?" : Math.round(endMs)} ms`
    )
    .join("\n");
}

/**
 * Dummy provider keys, shaped as the settings page saves them. They only ever
 * reach the local fakes, which accept any value; they are not keys.
 */
const storedKeys: StoredApiCredentials = {
  blizzardClientId: "profile-fake-blizzard-id",
  blizzardClientSecret: "profile-fake-blizzard-secret",
  raiderIoAccessKey: "profile-fake-raiderio-key",
  wclClientId: "profile-fake-wcl-id",
  wclClientSecret: "profile-fake-wcl-secret"
};

type LoadOptions = Readonly<{ withStoredKeys?: boolean }>;

async function loadOnce(
  browser: Browser,
  path: string,
  options: LoadOptions = {}
): Promise<LoadSample> {
  // A fresh context per load: no HTTP cache, no storage, no warm page. The
  // stored-keys scenarios put the keys back before any page script runs.
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-real-ip": "127.0.0.1" }
  });
  try {
    const page = await context.newPage();
    if (options.withStoredKeys) {
      await page.addInitScript(
        ({ key, value }) => window.localStorage.setItem(key, value),
        { key: credentialStorageKey, value: JSON.stringify(storedKeys) }
      );
    }
    await page.addInitScript(instrumentDossierLoad, earlyReadSlot);
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
    const sessionCheck = findSessionCheck(marks.prelude, marks.requestedMs);
    return {
      shellMs,
      ...(sessionCheck === undefined
        ? {}
        : {
            sessionCheckStartMs: sessionCheck.startMs,
            sessionCheckEndMs: sessionCheck.endMs
          }),
      ...(marks.requestedMs === undefined
        ? {}
        : { requestedMs: marks.requestedMs }),
      ...(marks.headersMs === undefined ? {} : { headersMs: marks.headersMs }),
      firstResponseMs: marks.firstResponseMs!,
      renderedMs: marks.renderedMs!,
      settledMs: marks.settledMs!,
      server: parseServerTiming(marks.serverTiming),
      earlyRead: marks.earlyRead,
      keysSent: marks.keysSent
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

/**
 * The serialised size of a full dossier read, in bytes. Taken from its own
 * request, so the measured loads stay exactly as the page makes them.
 */
async function dossierBytes(
  request: APIRequestContext,
  root: CharacterKey
): Promise<number> {
  const response = await request.get(
    `/api/dossiers/${root.region}/${root.realm}/${root.name}`
  );
  if (!response.ok()) throw new Error("profile_dossier_read_failed");
  return (await response.body()).byteLength;
}

/**
 * A dossier of `size` connected characters, each seeded by `seed`. The root
 * is one of them.
 */
async function seedDossier(
  root: CharacterKey,
  size: number,
  seed: (character: CharacterKey) => Promise<void>
): Promise<void> {
  const characters = [
    root,
    ...Array.from({ length: size - 1 }, (_, index) =>
      key(`${root.name}alt${suffix(index)}`)
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
  for (const character of characters) await seed(character);
}

async function profile(
  browser: Browser,
  scenario: string,
  path: string,
  count: number,
  options: LoadOptions = {}
): Promise<void> {
  // One discarded load first, so the process's first-request costs (route
  // compilation into memory, pool connections, JIT) are not billed to the
  // scenario. It is reported separately because a visitor can hit it too.
  const warmUp = await loadOnce(browser, path, options);
  const samples: LoadSample[] = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(await loadOnce(browser, path, options));
  }
  console.log(
    `${formatLoadSummary(scenario, summariseLoads(samples))}\n${formatPrelude()}\n  (warm-up load: rendered ${Math.round(warmUp.renderedMs)} ms, settled ${Math.round(warmUp.settledMs ?? 0)} ms)\n`
  );
}

test.describe.configure({ mode: "serial" });

test("warm read of a single character", async ({ browser, request }) => {
  // A fresh snapshot and completed evidence: nothing to discover or gather.
  const root = key("profilesingle");
  await seedSnapshot({
    key: root,
    displayName: title(root.name),
    refreshedAt: new Date()
  });
  await seedCharacterEvidence(root);

  console.log(`warm single: ${await dossierBytes(request, root)} bytes`);
  await profile(
    browser,
    "warm single",
    `/dossiers/eu/silvermoon/${root.name}`,
    loads
  );
});

test("warm read of a dossier at the character ceiling", async ({
  browser,
  request
}) => {
  // Twelve connected characters, the default DOSSIER_CHARACTER_CEILING, each
  // with completed evidence: the most characters the page reads.
  const root = key("profilewide");
  await seedDossier(root, 12, (character) => seedCharacterEvidence(character));

  console.log(`warm at ceiling: ${await dossierBytes(request, root)} bytes`);
  await profile(
    browser,
    "warm at ceiling",
    `/dossiers/eu/silvermoon/${root.name}`,
    loads
  );
});

/**
 * Evidence per character for the production-sized scenarios (#686), from the
 * six ten-character dossiers on `test` on 2026-09-27. Each dossier's total was
 * spread evenly over its ten characters. Aggregates only; see
 * `docs/research/2026-09-27-issue-666-dossier-db-calls.md`.
 */
const productionVolumes = {
  /** The median dossier: 759 kills, 1,613 wipes, 15 tier bests, 58 Cutting Edge. */
  median: { kills: 76, wipes: 161, tierBests: 2, cuttingEdges: 6 },
  /** The largest: 3,072 kills, 13,779 wipes, 70 tier bests, 184 Cutting Edge. */
  largest: { kills: 307, wipes: 1_378, tierBests: 7, cuttingEdges: 18 }
} as const satisfies Record<string, EvidenceVolume>;

for (const [size, volume] of Object.entries(productionVolumes)) {
  test(`warm read of a ${size} production-sized dossier`, async ({
    browser,
    request
  }) => {
    // Ten characters, the size of most production dossier reads, each with
    // synthetic completed evidence at production volume. Nothing to discover,
    // gather or look up, as in the other warm scenarios.
    const root = key(`profile${size}`);
    await seedDossier(root, 10, (character) =>
      seedSyntheticEvidence(character, volume)
    );

    const scenario = `warm, production ${size}`;
    console.log(`${scenario}: ${await dossierBytes(request, root)} bytes`);
    await profile(
      browser,
      scenario,
      `/dossiers/eu/silvermoon/${root.name}`,
      loads
    );
  });
}

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

test("warm read for a visitor with saved provider keys", async ({
  browser
}) => {
  // The warm single read, but the browser holds provider keys (#689). The
  // shell's early read stands aside, the page checks the account session
  // before sending the keys, and the read goes through the visitor's own
  // gateways, which neither read nor write the shared provider caches.
  const root = key("profilestored");
  await seedSnapshot({
    key: root,
    displayName: title(root.name),
    refreshedAt: new Date()
  });
  await seedCharacterEvidence(root);

  await profile(
    browser,
    "stored keys, warm",
    `/dossiers/eu/silvermoon/${root.name}`,
    loads,
    { withStoredKeys: true }
  );
});

test("read for a visitor with saved provider keys at provider latency", async ({
  browser
}) => {
  // The same character on every load, with the fakes answering after
  // PROFILE_PROVIDER_LATENCY_MS. An anonymous visitor's repeat reads would be
  // served its achievements from the shared cache; the visitor's own gateway
  // has none, so every load waits on the fake Blizzard.
  const root = key("profilestoredslow");
  await seedSnapshot({
    key: root,
    displayName: title(root.name),
    refreshedAt: new Date()
  });
  await seedCharacterEvidence(root);

  await setProviderLatency(providerLatencyMs);
  try {
    await profile(
      browser,
      `stored keys, providers at ${providerLatencyMs} ms`,
      `/dossiers/eu/silvermoon/${root.name}`,
      Math.max(1, Math.ceil(loads / 2)),
      { withStoredKeys: true }
    );
  } finally {
    await setProviderLatency(0);
  }
});
