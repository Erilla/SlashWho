/**
 * Recorded provider payloads: the allow-list each recording is projected
 * through, the redaction applied on the way, and the verifier that proves a
 * committed recording carries nothing the allow-list does not name.
 *
 * A recording is produced only by projecting a live response through the
 * policy below, so it can hold a field only if the policy names its path, and
 * only in the form that path's kind allows. The verifier re-derives that from
 * the file alone, with no credentials and no network, so the pull-request gate
 * can check every committed recording mechanically rather than trusting that
 * redaction "was applied".
 */

export type Provider = "blizzard" | "raiderio";

export type Endpoint =
  | "blizzard.character-profile"
  | "blizzard.guild-roster"
  | "blizzard.character-achievements"
  | "blizzard.playable-class-index"
  | "raiderio.character"
  | "raiderio.view-characters";

export type IdentityClass = "character" | "guild" | "owner" | "discord";

/**
 * How a leaf may appear in a recording. Every string kind is closed: a
 * placeholder, an enumerated value or a slug. No kind keeps free text.
 */
export type LeafKind =
  | { kind: "identity"; identity: IdentityClass }
  /** `/characters/<region>/<realm>/<character placeholder>`. */
  | { kind: "identity-path" }
  | { kind: "slug" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "number" }
  | { kind: "boolean" }
  /** Replaced with a synthetic sequence; the real value is a fingerprint. */
  | { kind: "timestamp" };

export type PolicyEntry = Readonly<{ path: string; leaf: LeafKind }>;

export type EndpointPolicy = Readonly<{
  provider: Provider;
  success: readonly PolicyEntry[];
  error: readonly PolicyEntry[];
  /** Arrays are cut to this many items; a recording needs shape, not volume. */
  maxItems?: Readonly<Record<string, number>>;
}>;

export type Recording = Readonly<{
  provider: Provider;
  endpoint: Endpoint;
  recordedOn: string;
  status: number;
  body: unknown;
}>;

export const playableClassNames = [
  "Death Knight",
  "Demon Hunter",
  "Druid",
  "Evoker",
  "Hunter",
  "Mage",
  "Monk",
  "Paladin",
  "Priest",
  "Rogue",
  "Shaman",
  "Warlock",
  "Warrior"
] as const;

const phonetic = [
  "Alfa",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliett",
  "Kilo",
  "Lima",
  "Mike",
  "November",
  "Oscar",
  "Papa",
  "Quebec",
  "Romeo",
  "Sierra",
  "Tango",
  "Uniform",
  "Victor",
  "Whiskey",
  "Xray",
  "Yankee",
  "Zulu"
] as const;

/**
 * The only values an identity path may hold, besides `""` and `null`. Each
 * list is closed, so the verifier needs no knowledge of the real identities to
 * prove none survived: anything outside the list fails. `Tournament`, `Retail`
 * and `fixture-owner` are the placeholders of the 2026-09-14 recording, which
 * predates this module.
 */
export const placeholders: Readonly<Record<IdentityClass, readonly string[]>> =
  {
    character: [...phonetic, "Tournament", "Retail"],
    guild: phonetic.map((word) => `Fixture Guild ${word}`),
    owner: [
      "fixture-owner",
      ...phonetic.map((word) => `fixture-owner-${word.toLowerCase()}`)
    ],
    discord: phonetic.map((word) => `fixture-discord-${word.toLowerCase()}`)
  };

/** Synthetic timestamps are whole UTC days counted from this instant. */
export const syntheticTimestampBase = Date.UTC(2020, 0, 1);
const dayMs = 24 * 60 * 60 * 1_000;

const slugPattern = /^[a-z0-9-]+$/;
const recordedOnPattern = /^\d{4}-\d{2}-\d{2}$/;
const identityPathPattern = /^\/characters\/([a-z]+)\/([a-z0-9-]+)\/([^/]+)$/;

// Belt and braces: every string kind is closed already, but a value that looks
// like a URL or a BattleTag is refused whatever path it sits at.
const forbiddenStringPatterns: readonly Readonly<{
  name: string;
  pattern: RegExp;
}>[] = [
  { name: "url", pattern: /[a-z][a-z0-9+.-]*:\/\//i },
  { name: "battletag", pattern: /#\d{4,6}\b/ },
  { name: "email", pattern: /[^\s@]+@[^\s@]+\.[^\s@]+/ }
];

const raiderIoCharacter = (prefix: string): PolicyEntry[] => [
  { path: `${prefix}.name`, leaf: { kind: "identity", identity: "character" } },
  { path: `${prefix}.level`, leaf: { kind: "number" } },
  {
    path: `${prefix}.class.name`,
    leaf: { kind: "enum", values: playableClassNames }
  },
  { path: `${prefix}.realm.slug`, leaf: { kind: "slug" } },
  {
    path: `${prefix}.realm.realmType`,
    leaf: { kind: "enum", values: ["live", "tr"] }
  },
  { path: `${prefix}.region.slug`, leaf: { kind: "slug" } },
  {
    path: `${prefix}.guild.name`,
    leaf: { kind: "identity", identity: "guild" }
  },
  { path: `${prefix}.guild.realm.slug`, leaf: { kind: "slug" } },
  { path: `${prefix}.guild.region.slug`, leaf: { kind: "slug" } }
];

// Error messages are closed too. A message this list does not name fails the
// recording loudly, because an unseen message is exactly the text that might
// echo back a requested name.
const raiderIoError: readonly PolicyEntry[] = [
  { path: "statusCode", leaf: { kind: "number" } },
  {
    path: "error",
    leaf: { kind: "enum", values: ["Bad Request", "Forbidden", "Not Found"] }
  },
  {
    path: "message",
    leaf: {
      kind: "enum",
      values: [
        "Cannot find user",
        "Could not find requested character",
        "The requested user's profile is private and cannot be viewed."
      ]
    }
  },
  {
    path: "errorCode",
    leaf: { kind: "enum", values: ["profile_is_private"] }
  }
];

const blizzardError: readonly PolicyEntry[] = [
  { path: "code", leaf: { kind: "number" } },
  {
    path: "type",
    leaf: {
      kind: "enum",
      values: ["BLZWEBAPI00000403", "BLZWEBAPI00000404"]
    }
  },
  { path: "detail", leaf: { kind: "enum", values: ["Forbidden", "Not Found"] } }
];

/**
 * The allow-list. A path names only fields a parser in `packages/` reads;
 * anything else is dropped on the way in, so a recording never carries gear,
 * scores, biographies, account ids or links.
 */
export const policies: Readonly<Record<Endpoint, EndpointPolicy>> = {
  "raiderio.character": {
    provider: "raiderio",
    success: [
      ...raiderIoCharacter("characterDetails.character"),
      {
        path: "characterDetails.isTournamentProfile",
        leaf: { kind: "boolean" }
      },
      {
        path: "characterDetails.user.name",
        leaf: { kind: "identity", identity: "owner" }
      },
      {
        path: "characterDetails.characterCustomizations.discord_profile",
        leaf: { kind: "identity", identity: "discord" }
      },
      {
        path: "characterDetails.characterCustomizations.main_character.name",
        leaf: { kind: "identity", identity: "character" }
      },
      {
        path: "characterDetails.characterCustomizations.main_character.path",
        leaf: { kind: "identity-path" }
      },
      {
        path: "characterDetails.characterCustomizations.main_character.realm.slug",
        leaf: { kind: "slug" }
      },
      {
        path: "characterDetails.characterCustomizations.main_character.region.slug",
        leaf: { kind: "slug" }
      }
    ],
    error: raiderIoError
  },
  "raiderio.view-characters": {
    provider: "raiderio",
    success: [
      {
        path: "viewUserCharactersApi.name",
        leaf: { kind: "identity", identity: "owner" }
      },
      ...raiderIoCharacter("viewUserCharactersApi.characters[].character")
    ],
    error: raiderIoError,
    maxItems: { "viewUserCharactersApi.characters": 10 }
  },
  "blizzard.character-profile": {
    provider: "blizzard",
    success: [
      { path: "guild.name", leaf: { kind: "identity", identity: "guild" } },
      { path: "guild.realm.slug", leaf: { kind: "slug" } }
    ],
    error: blizzardError
  },
  "blizzard.guild-roster": {
    provider: "blizzard",
    success: [
      {
        path: "members[].character.name",
        leaf: { kind: "identity", identity: "character" }
      },
      { path: "members[].character.level", leaf: { kind: "number" } },
      { path: "members[].character.realm.slug", leaf: { kind: "slug" } },
      {
        path: "members[].character.playable_class.id",
        leaf: { kind: "number" }
      },
      {
        path: "members[].character.playable_class.name",
        leaf: { kind: "enum", values: playableClassNames }
      }
    ],
    error: blizzardError,
    maxItems: { members: 10 }
  },
  "blizzard.character-achievements": {
    provider: "blizzard",
    success: [
      { path: "achievements[].id", leaf: { kind: "number" } },
      {
        path: "achievements[].completed_timestamp",
        leaf: { kind: "timestamp" }
      }
    ],
    error: blizzardError,
    maxItems: { achievements: 25 }
  },
  "blizzard.playable-class-index": {
    provider: "blizzard",
    success: [
      { path: "classes[].id", leaf: { kind: "number" } },
      {
        path: "classes[].name",
        leaf: { kind: "enum", values: playableClassNames }
      }
    ],
    error: blizzardError
  }
};

export function isEndpoint(value: unknown): value is Endpoint {
  return typeof value === "string" && Object.hasOwn(policies, value);
}

function entriesFor(
  endpoint: Endpoint,
  status: number
): readonly PolicyEntry[] {
  const policy = policies[endpoint];
  return status >= 200 && status < 300 ? policy.success : policy.error;
}

function join(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when some allowed leaf lies at or below `path`. */
function allowsBranch(entries: readonly PolicyEntry[], path: string): boolean {
  return entries.some(
    (entry) =>
      entry.path === path ||
      entry.path.startsWith(`${path}.`) ||
      entry.path.startsWith(`${path}[]`)
  );
}

function leafAt(
  entries: readonly PolicyEntry[],
  path: string
): LeafKind | undefined {
  return entries.find((entry) => entry.path === path)?.leaf;
}

// --- Recording -------------------------------------------------------------

export class RecordingRefused extends Error {
  constructor(
    readonly reason: string,
    readonly path: string,
    /** The offending upstream value; never written, shown only on request. */
    readonly value?: unknown
  ) {
    super(`${reason} at ${path === "" ? "<root>" : path}`);
  }
}

/**
 * Hands out placeholders for one recording session. The same real value always
 * maps to the same placeholder, across every file the session writes, so a
 * character's owner and the owner's profile still agree after redaction.
 */
export class PlaceholderBook {
  readonly #assigned = new Map<string, string>();
  readonly #used = new Map<IdentityClass, number>();
  readonly #seen = new Set<string>();

  placeholder(identity: IdentityClass, value: string, path: string): string {
    const key = `${identity}:${value.toLocaleLowerCase("en-US")}`;
    let assigned = this.#assigned.get(key);
    if (assigned === undefined) {
      const index = this.#used.get(identity) ?? 0;
      assigned = placeholders[identity][index];
      if (assigned === undefined) {
        throw new RecordingRefused("placeholders_exhausted", path);
      }
      this.#used.set(identity, index + 1);
      this.#assigned.set(key, assigned);
    }
    this.#seen.add(value);
    // A name the upstream sends lower-cased is kept lower-cased, so the
    // placeholder exercises the same casing the parser saw.
    return value === value.toLocaleLowerCase("en-US")
      ? assigned.toLocaleLowerCase("en-US")
      : assigned;
  }

  /** Every real identity value this session replaced. */
  replacedValues(): readonly string[] {
    return [...this.#seen];
  }
}

export type RecordOptions = Readonly<{
  endpoint: Endpoint;
  status: number;
  recordedOn: string;
  book: PlaceholderBook;
}>;

type Recorder = {
  entries: readonly PolicyEntry[];
  maxItems: Readonly<Record<string, number>>;
  book: PlaceholderBook;
  timestamps: number;
};

function recordLeaf(
  recorder: Recorder,
  leaf: LeafKind,
  value: unknown,
  path: string
): unknown {
  if (value === null) return null;

  switch (leaf.kind) {
    case "identity":
      if (typeof value !== "string")
        throw new RecordingRefused("unexpected_type", path);
      // Emptiness is shape, not identity: "" and whitespace are kept as "",
      // because the difference between "" and null is what broke #35.
      if (value.trim() === "") return "";
      return recorder.book.placeholder(leaf.identity, value, path);
    case "identity-path": {
      if (typeof value !== "string")
        throw new RecordingRefused("unexpected_type", path);
      const match = /^\/characters\/([^/]+)\/([^/]+)\/([^/?#]+)\/?$/i.exec(
        value
      );
      if (!match) throw new RecordingRefused("unrecognised_value", path, value);
      const [, region, realm, name] = match;
      return `/characters/${region!.toLocaleLowerCase("en-US")}/${realm!.toLocaleLowerCase("en-US")}/${recorder.book.placeholder("character", decodeURIComponent(name!), path)}`;
    }
    case "slug":
      if (typeof value !== "string")
        throw new RecordingRefused("unexpected_type", path);
      if (!slugPattern.test(value))
        throw new RecordingRefused("unrecognised_value", path, value);
      return value;
    case "enum":
      if (typeof value !== "string")
        throw new RecordingRefused("unexpected_type", path);
      if (!leaf.values.includes(value))
        throw new RecordingRefused("unrecognised_value", path, value);
      return value;
    case "number":
      if (typeof value !== "number")
        throw new RecordingRefused("unexpected_type", path);
      return value;
    case "boolean":
      if (typeof value !== "boolean")
        throw new RecordingRefused("unexpected_type", path);
      return value;
    case "timestamp":
      if (typeof value !== "number")
        throw new RecordingRefused("unexpected_type", path);
      recorder.timestamps += 1;
      return syntheticTimestampBase + recorder.timestamps * dayMs;
  }
}

function recordValue(
  recorder: Recorder,
  value: unknown,
  path: string
): unknown {
  const leaf = leafAt(recorder.entries, path);
  if (leaf) return recordLeaf(recorder, leaf, value, path);

  if (value === null) return null;
  if (Array.isArray(value)) {
    const limit = recorder.maxItems[path] ?? value.length;
    return value
      .slice(0, limit)
      .map((item) => recordValue(recorder, item, `${path}[]`));
  }
  if (isRecord(value)) {
    const kept: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = join(path, key);
      // Read only what the allow-list names, and skip the rest: an absent
      // field is left absent rather than refused.
      if (!allowsBranch(recorder.entries, childPath)) continue;
      kept[key] = recordValue(recorder, child, childPath);
    }
    return kept;
  }
  throw new RecordingRefused("unexpected_type", path);
}

/**
 * Projects a live response body through its endpoint's allow-list. Throws
 * {@link RecordingRefused} rather than writing anything it cannot classify.
 */
export function recordPayload(
  body: unknown,
  options: RecordOptions
): Recording {
  if (!recordedOnPattern.test(options.recordedOn))
    throw new Error("invalid_recorded_on");
  const policy = policies[options.endpoint];
  const recorder: Recorder = {
    entries: entriesFor(options.endpoint, options.status),
    maxItems: policy.maxItems ?? {},
    book: options.book,
    timestamps: 0
  };
  return {
    provider: policy.provider,
    endpoint: options.endpoint,
    recordedOn: options.recordedOn,
    status: options.status,
    body: recordValue(recorder, body, "")
  };
}

/**
 * The last check before a recording is written: none of the session's real
 * identity values may appear anywhere in the serialised file, in any case.
 * Only the recorder knows those values, so this runs at record time; the
 * committed-file gate is {@link verifyRecording}.
 */
export function leakedIdentities(
  serialised: string,
  book: PlaceholderBook
): readonly string[] {
  const haystack = serialised.toLocaleLowerCase("en-US");
  return book
    .replacedValues()
    .filter((value) => value.trim().length > 0)
    .filter((value) => haystack.includes(value.toLocaleLowerCase("en-US")));
}

// --- Verification ----------------------------------------------------------

export type Violation = Readonly<{ path: string; problem: string }>;

function isPlaceholder(identity: IdentityClass, value: string): boolean {
  const folded = value.toLocaleLowerCase("en-US");
  return placeholders[identity].some(
    (placeholder) => placeholder.toLocaleLowerCase("en-US") === folded
  );
}

function verifyLeaf(leaf: LeafKind, value: unknown): string | null {
  if (value === null) return null;

  switch (leaf.kind) {
    case "identity":
      if (typeof value !== "string") return "identity is not a string";
      return value === "" || isPlaceholder(leaf.identity, value)
        ? null
        : `identity is not a ${leaf.identity} placeholder`;
    case "identity-path": {
      if (typeof value !== "string") return "path is not a string";
      const match = identityPathPattern.exec(value);
      return match && isPlaceholder("character", match[3]!)
        ? null
        : "path does not end in a character placeholder";
    }
    case "slug":
      return typeof value === "string" && slugPattern.test(value)
        ? null
        : "not a lower-case slug";
    case "enum":
      return typeof value === "string" && leaf.values.includes(value)
        ? null
        : "value is not in the enumerated set";
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "not a finite number";
    case "boolean":
      return typeof value === "boolean" ? null : "not a boolean";
    case "timestamp":
      return typeof value === "number" &&
        value > syntheticTimestampBase &&
        (value - syntheticTimestampBase) % dayMs === 0
        ? null
        : "timestamp is not synthetic";
  }
}

function verifyValue(
  entries: readonly PolicyEntry[],
  value: unknown,
  path: string,
  violations: Violation[]
): void {
  if (typeof value === "string") {
    for (const { name, pattern } of forbiddenStringPatterns) {
      if (pattern.test(value))
        violations.push({ path, problem: `string looks like a ${name}` });
    }
  }

  const leaf = leafAt(entries, path);
  if (leaf) {
    const problem = verifyLeaf(leaf, value);
    if (problem) violations.push({ path, problem });
    return;
  }
  if (value === null) return;
  if (!allowsBranch(entries, path) && path !== "") {
    violations.push({ path, problem: "path is not on the allow-list" });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      verifyValue(entries, item, `${path}[]`, violations);
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value))
      verifyValue(entries, child, join(path, key), violations);
    return;
  }
  violations.push({ path, problem: "leaf at a branch path" });
}

const envelopeKeys = ["provider", "endpoint", "recordedOn", "status", "body"];

/**
 * Proves a committed recording carries only what the allow-list names, in the
 * form its kind allows. It needs nothing but the file.
 */
export function verifyRecording(value: unknown): readonly Violation[] {
  if (!isRecord(value)) return [{ path: "", problem: "not an object" }];

  const violations: Violation[] = [];
  for (const key of Object.keys(value)) {
    if (!envelopeKeys.includes(key))
      violations.push({ path: key, problem: "unknown envelope field" });
  }
  const { provider, endpoint, recordedOn, status, body } = value;
  if (!isEndpoint(endpoint))
    return [...violations, { path: "endpoint", problem: "unknown endpoint" }];
  if (provider !== policies[endpoint].provider)
    violations.push({ path: "provider", problem: "does not match endpoint" });
  if (typeof recordedOn !== "string" || !recordedOnPattern.test(recordedOn))
    violations.push({ path: "recordedOn", problem: "not a YYYY-MM-DD date" });
  if (typeof status !== "number" || !Number.isInteger(status))
    return [...violations, { path: "status", problem: "not an integer" }];

  const bodyViolations: Violation[] = [];
  verifyValue(entriesFor(endpoint, status), body, "", bodyViolations);
  return [
    ...violations,
    ...bodyViolations.map((violation) => ({
      ...violation,
      path: violation.path === "" ? "body" : `body.${violation.path}`
    }))
  ];
}

// --- Shape conformance -----------------------------------------------------

export type ValueKind =
  | "object"
  | "array"
  | "string"
  | "empty-string"
  | "null"
  | "number"
  | "boolean";

function valueKind(value: unknown): ValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string")
    return value === "" ? "empty-string" : "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

/**
 * Every `path: kind` pair a value exhibits, arrays folded to `[]`. Two bodies
 * with the same shape produce the same set, whatever their values.
 */
export function shapeOf(value: unknown, path = ""): ReadonlySet<string> {
  const shape = new Set<string>();
  const visit = (current: unknown, currentPath: string) => {
    shape.add(
      `${currentPath === "" ? "<root>" : currentPath}: ${valueKind(current)}`
    );
    if (Array.isArray(current)) {
      for (const item of current) visit(item, `${currentPath}[]`);
    } else if (isRecord(current)) {
      for (const [key, child] of Object.entries(current))
        visit(child, join(currentPath, key));
    }
  };
  visit(value, path);
  return shape;
}

/**
 * The `path: kind` pairs a hand-built body asserts that no recording of the
 * same endpoint and status class has ever shown. A fixture inventing a field
 * the upstream does not send -- `playable_class.name` on a roster member, #38
 * -- appears here.
 */
export function unobservedShape(
  body: unknown,
  recordings: readonly Recording[]
): readonly string[] {
  const observed = new Set<string>();
  for (const recording of recordings)
    for (const entry of shapeOf(recording.body)) observed.add(entry);
  return [...shapeOf(body)].filter((entry) => !observed.has(entry)).sort();
}
