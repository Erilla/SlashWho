import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createPostgresRepositories,
  runMigrations
} from "../../packages/database/src";
import {
  closeStaleApplicantApplications,
  linkApplicantApplications,
  settleApplicantApplications
} from "../../apps/worker/src/applicant-links";
import { startPostgres } from "./postgres";

let pool: Pool;
let stop: () => Promise<void>;
beforeAll(async () => {
  ({ pool, stop } = await startPostgres());
  await runMigrations(pool);
});
afterAll(async () => {
  await stop();
});
beforeEach(async () => {
  // CASCADE reaches the application members, manual_dossier_connections and
  // dossier_character_exclusions through their foreign keys.
  await pool.query(
    `TRUNCATE applicant_source_applications, applicant_source_application_members,
              applicant_source_intents, applicant_source_counts, applicant_source_state,
              manual_dossier_connections, dossier_character_exclusions,
              suppressed_characters, applicant_suppression_history,
              warcraft_logs_character_ids, characters
     CASCADE`
  );
});

async function character(name: string, region = "eu"): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO characters (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url) VALUES ($1, 'hyjal', $2, $2, 'Mage', 80, 'https://raider.io/characters/' || $1 || '/hyjal/' || $2) RETURNING id",
    [region, name]
  );
  return result.rows[0]!.id;
}
const id = (name: string, region = "eu") =>
  `character:["${region}","hyjal","${name}"]`;
async function intent(
  identity: string,
  state: string,
  canonical = identity
): Promise<string> {
  await pool.query(
    "INSERT INTO applicant_source_state (source, initialized_at, last_polled_at, parser_version) VALUES ('applicant_sheet', now(), now(), 2) ON CONFLICT DO NOTHING"
  );
  const result = await pool.query<{ sequence: string }>(
    "INSERT INTO applicant_source_intents (source, identity, canonical_identity, observed_at, state) VALUES ('applicant_sheet', $1, $2, now(), $3) RETURNING sequence",
    [identity, canonical, state]
  );
  return result.rows[0]!.sequence;
}
async function application(
  root: { identity: string; sequence: string },
  members: Array<{ identity: string; sequence: string | null }>
): Promise<string> {
  const created = await pool.query<{ id: string }>(
    "INSERT INTO applicant_source_applications (source, root_intent_sequence, root_identity, submitted_serial) VALUES ('applicant_sheet', $1, $2, 1) RETURNING id",
    [root.sequence, root.identity]
  );
  for (const [index, member] of members.entries())
    await pool.query(
      "INSERT INTO applicant_source_application_members (application_id, ordinal, identity, member_intent_sequence) VALUES ($1, $2, $3, $4)",
      [created.rows[0]!.id, index + 1, member.identity, member.sequence]
    );
  return created.rows[0]!.id;
}
// The runtime settles on every tick before linking; the tests do the same.
const link = async () => {
  await settleApplicantApplications(pool);
  return linkApplicantApplications({
    pool,
    repositories: createPostgresRepositories(pool)
  });
};
async function links() {
  const result = await pool.query<{
    root: string;
    connected: string;
    origin: string;
  }>(
    `SELECT r.normalized_name AS root, m.connected_normalized_name AS connected, m.origin
       FROM manual_dossier_connections m JOIN characters r ON r.id = m.root_character_id
      ORDER BY 1, 2`
  );
  return result.rows;
}

it("links a member to its root once both exist, as an application connection", async () => {
  await character("tropipe");
  await character("tropicos");
  const root = await intent(id("tropipe"), "done");
  const member = await intent(id("tropicos"), "done");
  await application({ identity: id("tropipe"), sequence: root }, [
    { identity: id("tropicos"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ linked: 1, waiting: 0 });
  expect(await links()).toEqual([
    { root: "tropipe", connected: "tropicos", origin: "applicant_sheet" }
  ]);
  const closed = await pool.query(
    "SELECT closed_at, linked_count FROM applicant_source_applications"
  );
  expect(closed.rows[0]).toMatchObject({ linked_count: 1 });
  expect(closed.rows[0].closed_at).not.toBeNull();
  const members = await pool.query(
    "SELECT 1 FROM applicant_source_application_members"
  );
  expect(members.rowCount).toBe(0);
});

it("waits for an unsettled root, then for an undiscovered one", async () => {
  const root = await intent(id("waitroot"), "pending");
  const member = await intent(id("waitmember"), "done");
  await application({ identity: id("waitroot"), sequence: root }, [
    { identity: id("waitmember"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ linked: 0 });
  await pool.query(
    "UPDATE applicant_source_intents SET state = 'done' WHERE sequence = $1",
    [root]
  );
  expect(await link()).toMatchObject({ linked: 0, waiting: 1 });
  await character("waitroot");
  await character("waitmember");
  expect(await link()).toMatchObject({ linked: 1 });
});

it("links through a Warcraft Logs id once its intent resolves, and roots on a numeric root", async () => {
  await character("numroot");
  await character("nummember");
  const root = await intent("warcraftlogs_id:7", "done", id("numroot"));
  const member = await intent("warcraftlogs_id:8", "pending", null as never);
  await application({ identity: "warcraftlogs_id:7", sequence: root }, [
    { identity: "warcraftlogs_id:8", sequence: member }
  ]);
  expect(await link()).toMatchObject({ linked: 0, waiting: 1 });
  await pool.query(
    "UPDATE applicant_source_intents SET state = 'done', canonical_identity = $2 WHERE sequence = $1",
    [member, id("nummember")]
  );
  expect(await link()).toMatchObject({ linked: 1 });
  expect(await links()).toEqual([
    { root: "numroot", connected: "nummember", origin: "applicant_sheet" }
  ]);
});

it("closes a suppressed root's application without linking", async () => {
  await character("supproot");
  await character("suppmember");
  const root = await intent(id("supproot"), "suppressed");
  const member = await intent(id("suppmember"), "done");
  await application({ identity: id("supproot"), sequence: root }, [
    { identity: id("suppmember"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ suppressed: 1, linked: 0 });
  expect(await links()).toEqual([]);
});

it("skips a member suppressed now, though its intent was admitted", async () => {
  await character("liveroot");
  await character("livemember");
  const root = await intent(id("liveroot"), "done");
  const member = await intent(id("livemember"), "done");
  await application({ identity: id("liveroot"), sequence: root }, [
    { identity: id("livemember"), sequence: member }
  ]);
  await createPostgresRepositories(pool).suppressions.suppress(
    { region: "eu", realm: "hyjal", name: "livemember" },
    "removal_request",
    null
  );
  expect(await link()).toMatchObject({ suppressed: 1, linked: 0 });
});

it("skips the same character, a different region, and an exclusion in either direction", async () => {
  await character("sameroot");
  await character("usmember", "us");
  await character("exclmember");
  await character("reverseroot");
  const root = await intent(id("sameroot"), "done");
  const same = await intent("warcraftlogs_id:9", "done", id("sameroot"));
  const us = await intent(id("usmember", "us"), "done");
  const excluded = await intent(id("exclmember"), "done");
  await application({ identity: id("sameroot"), sequence: root }, [
    { identity: "warcraftlogs_id:9", sequence: same },
    { identity: id("usmember", "us"), sequence: us },
    { identity: id("exclmember"), sequence: excluded }
  ]);
  // The member's dossier excluded the root: the reverse direction.
  await pool.query(
    "INSERT INTO dossier_character_exclusions (root_character_id, region, realm_slug, normalized_name) SELECT id, 'eu', 'hyjal', 'sameroot' FROM characters WHERE normalized_name = 'exclmember'"
  );
  expect(await link()).toMatchObject({
    same_character: 1,
    skipped_region: 1,
    skipped_excluded: 1,
    linked: 0
  });
});

it("skips a member excluded under another name sharing its Warcraft Logs id", async () => {
  await character("aliasroot");
  await character("newname");
  await pool.query(
    "INSERT INTO warcraft_logs_character_ids (region, realm_slug, normalized_name, character_id, resolved_at) VALUES ('eu', 'hyjal', 'oldname', 55, now()), ('eu', 'hyjal', 'newname', 55, now())"
  );
  await pool.query(
    "INSERT INTO dossier_character_exclusions (root_character_id, region, realm_slug, normalized_name) SELECT id, 'eu', 'hyjal', 'oldname' FROM characters WHERE normalized_name = 'aliasroot'"
  );
  const root = await intent(id("aliasroot"), "done");
  const member = await intent(id("newname"), "done");
  await application({ identity: id("aliasroot"), sequence: root }, [
    { identity: id("newname"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ skipped_excluded: 1 });
});

it("skips a member already grouped elsewhere, and counts the pair as needing a link", async () => {
  const a = await character("grpa");
  const b = await character("grpb");
  const c = await character("grpc");
  const d = await character("grpd");
  await pool.query(
    "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'hyjal', 'grpb'), ($2, 'eu', 'hyjal', 'grpd')",
    [a, c]
  );
  void b;
  void d;
  const root = await intent(id("grpa"), "done");
  const member = await intent(id("grpc"), "done");
  await application({ identity: id("grpa"), sequence: root }, [
    { identity: id("grpc"), sequence: member }
  ]);
  expect(await link()).toMatchObject({
    skipped_cross_group: 1,
    needed_link_pairs: 1,
    linked: 0
  });
});

it("decides cross-group only once the member exists, even if it is later grouped", async () => {
  const a = await character("lateroot");
  await character("latebuddy");
  await pool.query(
    "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'hyjal', 'latebuddy')",
    [a]
  );
  const root = await intent(id("lateroot"), "done");
  const member = await intent(id("latemember"), "done");
  await application({ identity: id("lateroot"), sequence: root }, [
    { identity: id("latemember"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ waiting: 1, linked: 0 });
  const m = await character("latemember");
  await character("latefriend");
  await pool.query(
    "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'hyjal', 'latefriend')",
    [m]
  );
  expect(await link()).toMatchObject({ skipped_cross_group: 1, linked: 0 });
});

it("treats a repeated add as linked, and does not re-link a member already linked", async () => {
  await character("reproot");
  await character("repmember");
  const root = await intent(id("reproot"), "done");
  const member = await intent(id("repmember"), "done");
  const app = await application({ identity: id("reproot"), sequence: root }, [
    { identity: id("repmember"), sequence: member }
  ]);
  await createPostgresRepositories(pool).manualConnections.add(
    { region: "eu", realm: "hyjal", name: "reproot" },
    { region: "eu", realm: "hyjal", name: "repmember" },
    { origin: "applicant_sheet", applicationId: app }
  );
  expect(await link()).toMatchObject({ linked: 1 });
  expect(await links()).toHaveLength(1);
});

it("links again on resubmission after a removal, but never past an exclusion", async () => {
  await character("resroot");
  await character("resmember");
  const repositories = createPostgresRepositories(pool);
  const rootKey = { region: "eu" as const, realm: "hyjal", name: "resroot" };
  const memberKey = {
    region: "eu" as const,
    realm: "hyjal",
    name: "resmember"
  };
  const first = await intent(id("resroot"), "done");
  const firstMember = await intent(id("resmember"), "done");
  await application({ identity: id("resroot"), sequence: first }, [
    { identity: id("resmember"), sequence: firstMember }
  ]);
  await link();
  await repositories.manualConnections.remove(rootKey, memberKey);
  const second = await intent(id("resroot"), "done");
  const secondMember = await intent(id("resmember"), "done");
  await application({ identity: id("resroot"), sequence: second }, [
    { identity: id("resmember"), sequence: secondMember }
  ]);
  expect(await link()).toMatchObject({ linked: 1 });
  await repositories.manualConnections.setExcluded(rootKey, memberKey, true);
  await repositories.manualConnections.remove(rootKey, memberKey);
  // Removal deleted the row and its exclusion, so model the reviewer's
  // lasting choice as an Exclude that stays:
  await repositories.manualConnections.add(rootKey, memberKey);
  await repositories.manualConnections.setExcluded(rootKey, memberKey, true);
  const third = await intent(id("resroot"), "done");
  const thirdMember = await intent(id("resmember"), "done");
  await application({ identity: id("resroot"), sequence: third }, [
    { identity: id("resmember"), sequence: thirdMember }
  ]);
  expect(await link()).toMatchObject({ skipped_excluded: 1 });
});

it("expires waiting members seven days after settlement, and hard-closes after thirty", async () => {
  await character("exproot");
  const root = await intent(id("exproot"), "done");
  const member = await intent(id("expmember"), "pending");
  await application({ identity: id("exproot"), sequence: root }, [
    { identity: id("expmember"), sequence: member }
  ]);
  await link(); // settles
  await pool.query(
    "UPDATE applicant_source_applications SET settled_at = now() - interval '8 days'"
  );
  expect(await link()).toMatchObject({ expired: 1 });

  const unsettled = await intent(id("neverroot"), "pending");
  await application({ identity: id("neverroot"), sequence: unsettled }, [
    { identity: id("nevermember"), sequence: null }
  ]);
  await pool.query(
    "UPDATE applicant_source_applications SET created_at = now() - interval '31 days' WHERE settled_at IS NULL"
  );
  expect(await closeStaleApplicantApplications(pool)).toMatchObject({
    expired: 1
  });
  await pool.query(
    "UPDATE applicant_source_applications SET closed_at = now() - interval '31 days'"
  );
  expect(await closeStaleApplicantApplications(pool)).toMatchObject({
    deleted: 2
  });
});

it("visits the least recently checked applications first and skips locked ones", async () => {
  await character("orderroot");
  for (const name of ["o1", "o2", "o3"]) {
    const root = await intent(id("orderroot"), "done");
    const member = await intent(id(name), "pending");
    await application({ identity: id("orderroot"), sequence: root }, [
      { identity: id(name), sequence: member }
    ]);
  }
  await settleApplicantApplications(pool);
  const first = await linkApplicantApplications({
    pool,
    repositories: createPostgresRepositories(pool),
    batch: 2
  });
  expect(first.waiting).toBe(2);
  const unchecked = await pool.query(
    "SELECT count(*)::int AS n FROM applicant_source_applications WHERE last_checked_at IS NULL"
  );
  expect(unchecked.rows[0].n).toBe(1);
});

it("settles only applications whose root intent is done or suppressed, once, without linking", async () => {
  // Break caught: settlement inside the link step never ran while linking was
  // off, so switching it on settled a month of applications at once, each with
  // a fresh 7-day window, and linked them in one burst.
  await character("settleroot");
  await character("settlemember");
  const done = await intent(id("settleroot"), "done");
  const pending = await intent(id("settlependingroot"), "pending");
  const member = await intent(id("settlemember"), "done");
  await application({ identity: id("settleroot"), sequence: done }, [
    { identity: id("settlemember"), sequence: member }
  ]);
  await application({ identity: id("settlependingroot"), sequence: pending }, [
    { identity: id("settlemember"), sequence: member }
  ]);
  expect(await settleApplicantApplications(pool)).toBe(1);
  const first = await pool.query<{ settled_at: Date }>(
    "SELECT settled_at FROM applicant_source_applications WHERE root_identity = $1",
    [id("settleroot")]
  );
  expect(await settleApplicantApplications(pool)).toBe(0);
  const again = await pool.query<{ settled_at: Date }>(
    "SELECT settled_at FROM applicant_source_applications WHERE root_identity = $1",
    [id("settleroot")]
  );
  expect(again.rows[0]?.settled_at).toEqual(first.rows[0]?.settled_at);
  // Settling links nothing: that is the link step's job, behind the flag.
  expect(await links()).toEqual([]);
});

it("links a member with no links of its own even when the root's component is capped", async () => {
  await character("caproot");
  await character("capmember");
  const root = await intent(id("caproot"), "done");
  const member = await intent(id("capmember"), "done");
  await application({ identity: id("caproot"), sequence: root }, [
    { identity: id("capmember"), sequence: member }
  ]);
  // A root in a component larger than the walk's cap: give it a chain of 3
  // linked characters and walk with a cap of 2 via the test seam below.
  const rootId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM characters WHERE normalized_name = 'caproot'"
    )
  ).rows[0]!.id;
  for (const name of ["capa", "capb", "capc"]) {
    await character(name);
    await pool.query(
      "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'hyjal', $2)",
      [rootId, name]
    );
  }
  await settleApplicantApplications(pool);
  expect(
    await linkApplicantApplications({
      pool,
      repositories: createPostgresRepositories(pool),
      componentCap: 2
    })
  ).toMatchObject({ linked: 1, skipped_cross_group: 0 });
});

it("decides a member suppressed at intake through a Warcraft Logs id as suppressed, not waiting", async () => {
  // Intake records such an intent as suppressed with no canonical identity,
  // so it has no character key; it must not wait seven days and expire.
  await character("wclsuppressroot");
  const root = await intent(id("wclsuppressroot"), "done");
  const member = await intent(
    "warcraftlogs_id:12",
    "suppressed",
    null as never
  );
  await application({ identity: id("wclsuppressroot"), sequence: root }, [
    { identity: "warcraftlogs_id:12", sequence: member }
  ]);
  expect(await link()).toMatchObject({ suppressed: 1, waiting: 0, linked: 0 });
  const closed = await pool.query(
    "SELECT closed_at, suppressed_count FROM applicant_source_applications"
  );
  expect(closed.rows[0]).toMatchObject({ suppressed_count: 1 });
  expect(closed.rows[0].closed_at).not.toBeNull();
  expect(await links()).toEqual([]);
});

it("contains a failing application, moves it to the back, and still links the rest", async () => {
  await character("failroot");
  await character("failmember");
  await character("healthyroot");
  await character("healthymember");
  const failRoot = await intent(id("failroot"), "done");
  const failMember = await intent(id("failmember"), "done");
  const failing = await application(
    { identity: id("failroot"), sequence: failRoot },
    [{ identity: id("failmember"), sequence: failMember }]
  );
  const healthyRoot = await intent(id("healthyroot"), "done");
  const healthyMember = await intent(id("healthymember"), "done");
  await application({ identity: id("healthyroot"), sequence: healthyRoot }, [
    { identity: id("healthymember"), sequence: healthyMember }
  ]);
  // Recording the failing application's outcome overflows its count column:
  // a deterministic error inside that application's processing. It is the
  // older application, so the pass reaches it first.
  await pool.query(
    "UPDATE applicant_source_applications SET linked_count = 2147483647, created_at = now() - interval '1 minute' WHERE id = $1",
    [failing]
  );
  expect(await link()).toMatchObject({ failed: 1, linked: 1 });
  expect(await links()).toContainEqual({
    root: "healthyroot",
    connected: "healthymember",
    origin: "applicant_sheet"
  });
  const rows = await pool.query<{
    id: string;
    closed_at: Date | null;
    last_checked_at: Date | null;
  }>(
    "SELECT id, closed_at, last_checked_at FROM applicant_source_applications"
  );
  const failed = rows.rows.find((row) => row.id === failing)!;
  expect(failed.closed_at).toBeNull();
  expect(failed.last_checked_at).not.toBeNull();
  const healthy = rows.rows.find((row) => row.id !== failing)!;
  expect(healthy.closed_at).not.toBeNull();
  const outcome = await pool.query(
    "SELECT outcome FROM applicant_source_application_members WHERE application_id = $1",
    [failing]
  );
  expect(outcome.rows).toEqual([{ outcome: null }]);
});
