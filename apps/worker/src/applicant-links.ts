import type { Pool, PoolClient } from "pg";
import { countingComponents, type Repositories } from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import { decodeApplicantIdentity } from "./applicant-identity";

export type ApplicantLinkCounts = {
  linked: number;
  waiting: number;
  suppressed: number;
  same_character: number;
  skipped_region: number;
  skipped_excluded: number;
  skipped_cross_group: number;
  needed_link_pairs: number;
  expired: number;
  /** Applications whose processing threw; rolled back and moved to the back. */
  failed: number;
};

type Outcome = Exclude<
  keyof ApplicantLinkCounts,
  "waiting" | "needed_link_pairs" | "failed"
>;

const settleAfterDays = 7;

function emptyCounts(): ApplicantLinkCounts {
  return {
    linked: 0,
    waiting: 0,
    suppressed: 0,
    same_character: 0,
    skipped_region: 0,
    skipped_excluded: 0,
    skipped_cross_group: 0,
    needed_link_pairs: 0,
    expired: 0,
    failed: 0
  };
}

function addCounts(
  total: ApplicantLinkCounts,
  part: ApplicantLinkCounts
): void {
  for (const name of Object.keys(total) as Array<keyof ApplicantLinkCounts>)
    total[name] += part[name];
}

type PickedApplication = {
  id: string;
  settled_at: Date;
  root_state: string;
  root_canonical: string | null;
};

type LinkInput = {
  pool: Pool;
  repositories: Pick<Repositories, "manualConnections" | "suppressions">;
  now?: Date;
  batch?: number;
  /** The counting-component walk's node cap; defaults to 2,000. A test seam. */
  componentCap?: number;
};

/** Undefined for a numeric identity, or one that does not decode: one bad row never fails the pass. */
function keyOf(canonicalIdentity: string): CharacterKey | undefined {
  try {
    const decoded = decodeApplicantIdentity(canonicalIdentity);
    return decoded.kind === "character" ? decoded.key : undefined;
  } catch {
    return undefined;
  }
}

async function characterId(
  client: PoolClient,
  key: CharacterKey
): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM characters WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3",
    [key.region, key.realm, key.name]
  );
  return result.rows[0]?.id;
}

/**
 * Whether `owner`'s dossier has excluded `other`, under `other`'s own key or
 * any key sharing its Warcraft Logs character id -- exclusions are written
 * under every such key when they are made, so a renamed character is caught.
 */
async function hasExcluded(
  client: PoolClient,
  ownerId: string,
  other: CharacterKey
): Promise<boolean> {
  const result = await client.query(
    `WITH other_keys AS (
       SELECT $2::text AS region, $3::text AS realm_slug, $4::text AS normalized_name
       UNION
       SELECT alias.region, alias.realm_slug, alias.normalized_name
         FROM warcraft_logs_character_ids self
         JOIN warcraft_logs_character_ids alias
           ON alias.character_id = self.character_id AND alias.region = self.region
        WHERE self.region = $2 AND self.realm_slug = $3 AND self.normalized_name = $4
     )
     SELECT 1 FROM other_keys k
      WHERE EXISTS (
              SELECT 1 FROM manual_dossier_connections manual
               WHERE manual.root_character_id = $1 AND manual.excluded_at IS NOT NULL
                 AND manual.connected_region = k.region
                 AND manual.connected_realm_slug = k.realm_slug
                 AND manual.connected_normalized_name = k.normalized_name)
         OR EXISTS (
              SELECT 1 FROM dossier_character_exclusions exclusion
               WHERE exclusion.root_character_id = $1
                 AND exclusion.region = k.region
                 AND exclusion.realm_slug = k.realm_slug
                 AND exclusion.normalized_name = k.normalized_name)
      LIMIT 1`,
    [ownerId, other.region, other.realm, other.name]
  );
  return result.rowCount === 1;
}

async function close(client: PoolClient, applicationId: string): Promise<void> {
  await client.query(
    "UPDATE applicant_source_applications SET closed_at = now() WHERE id = $1",
    [applicationId]
  );
  // Which characters were submitted together is not kept once decided.
  await client.query(
    "DELETE FROM applicant_source_application_members WHERE application_id = $1",
    [applicationId]
  );
}

async function decide(
  client: PoolClient,
  applicationId: string,
  ordinal: number,
  outcome: Outcome,
  counts: ApplicantLinkCounts
): Promise<void> {
  await client.query(
    "UPDATE applicant_source_application_members SET outcome = $3 WHERE application_id = $1 AND ordinal = $2",
    [applicationId, ordinal, outcome]
  );
  await client.query(
    `UPDATE applicant_source_applications SET ${outcome}_count = ${outcome}_count + 1 WHERE id = $1`,
    [applicationId]
  );
  counts[outcome]++;
}

/**
 * Stamps settlement once a root intent is done or suppressed. Runs on every
 * watcher tick whatever the linking flag says, so the 7-day expiry always runs
 * from when the root settled -- not from whenever linking was switched on.
 * Idempotent: only NULL settled_at is written.
 */
export async function settleApplicantApplications(pool: Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE applicant_source_applications application
        SET settled_at = now()
       FROM applicant_source_intents intent
      WHERE intent.sequence = application.root_intent_sequence
        AND intent.state IN ('done', 'suppressed')
        AND application.settled_at IS NULL
        AND application.closed_at IS NULL`
  );
  return result.rowCount ?? 0;
}

/**
 * One application's decisions. A throw leaves the caller to roll back to its
 * savepoint; adds already made are harmless repeats on the next pass.
 */
async function linkApplication(
  client: PoolClient,
  input: LinkInput,
  application: PickedApplication,
  now: Date,
  counts: ApplicantLinkCounts
): Promise<void> {
  const members = await client.query<{
    ordinal: number;
    identity: string;
    state: string | null;
    canonical: string | null;
  }>(
    `SELECT member.ordinal, member.identity, intent.state, intent.canonical_identity AS canonical
       FROM applicant_source_application_members member
       LEFT JOIN applicant_source_intents intent ON intent.sequence = member.member_intent_sequence
      WHERE member.application_id = $1 AND member.outcome IS NULL
      ORDER BY member.ordinal`,
    [application.id]
  );
  const expired =
    now.getTime() - application.settled_at.getTime() >=
    settleAfterDays * 86_400_000;
  const rootKey = application.root_canonical
    ? keyOf(application.root_canonical)
    : undefined;
  const rootSuppressed =
    application.root_state === "suppressed" ||
    (rootKey !== undefined &&
      (await input.repositories.suppressions.isActive(rootKey, now)));
  if (rootSuppressed) {
    for (const member of members.rows)
      await decide(
        client,
        application.id,
        member.ordinal,
        "suppressed",
        counts
      );
    await close(client, application.id);
    return;
  }
  const rootId = rootKey ? await characterId(client, rootKey) : undefined;
  let open = 0;
  for (const member of members.rows) {
    // Suppressed at intake: decided at once. A Warcraft Logs id suppressed
    // there has no canonical identity, so it would otherwise wait for a key
    // it can never get, and expire.
    if (member.state === "suppressed") {
      await decide(
        client,
        application.id,
        member.ordinal,
        "suppressed",
        counts
      );
      continue;
    }
    const settled = member.state === "done";
    const memberKey = member.canonical
      ? keyOf(member.canonical)
      : keyOf(member.identity);
    if (!rootId || !settled || !memberKey) {
      if (expired)
        await decide(client, application.id, member.ordinal, "expired", counts);
      else open++;
      continue;
    }
    if (await input.repositories.suppressions.isActive(memberKey, now)) {
      await decide(
        client,
        application.id,
        member.ordinal,
        "suppressed",
        counts
      );
      continue;
    }
    // A character identity is its own canonical identity.
    if ((member.canonical ?? member.identity) === application.root_canonical) {
      await decide(
        client,
        application.id,
        member.ordinal,
        "same_character",
        counts
      );
      continue;
    }
    const memberId = await characterId(client, memberKey);
    if (!memberId) {
      if (expired)
        await decide(client, application.id, member.ordinal, "expired", counts);
      else open++;
      continue;
    }
    if (memberKey.region !== rootKey!.region) {
      await decide(
        client,
        application.id,
        member.ordinal,
        "skipped_region",
        counts
      );
      continue;
    }
    if (
      (await hasExcluded(client, rootId, memberKey)) ||
      (await hasExcluded(client, memberId, rootKey!))
    ) {
      await decide(
        client,
        application.id,
        member.ordinal,
        "skipped_excluded",
        counts
      );
      continue;
    }
    const components = await countingComponents(
      input.pool,
      rootId,
      memberId,
      input.componentCap
    );
    if (!components.same) {
      counts.needed_link_pairs++;
      // A capped walk leaves "same" unknown, so treat the pair as two
      // groups -- but a member with no links of its own merges nothing,
      // and links whatever the root's component size.
      if (components.rootShared && components.memberShared) {
        await decide(
          client,
          application.id,
          member.ordinal,
          "skipped_cross_group",
          counts
        );
        continue;
      }
    }
    await input.repositories.manualConnections.add(rootKey!, memberKey, {
      origin: "applicant_sheet",
      applicationId: application.id
    });
    await decide(client, application.id, member.ordinal, "linked", counts);
  }
  counts.waiting += open;
  if (open === 0) await close(client, application.id);
}

/**
 * Links each settled application's members to its root, one decision per
 * member, never deciding on a character that does not exist yet. Makes no
 * provider calls. Settlement is not its job: see settleApplicantApplications.
 */
export async function linkApplicantApplications(
  input: LinkInput
): Promise<ApplicantLinkCounts> {
  const now = input.now ?? new Date();
  const counts = emptyCounts();
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    // NO KEY UPDATE, not UPDATE: manualConnections.add runs on another pool
    // connection, and its foreign key to this row takes FOR KEY SHARE, which
    // FOR UPDATE would block until this transaction ends -- forever. NO KEY
    // UPDATE still keeps a second worker off the row through SKIP LOCKED.
    const picked = await client.query<PickedApplication>(
      `SELECT application.id, application.settled_at,
              intent.state AS root_state, intent.canonical_identity AS root_canonical
         FROM applicant_source_applications application
         JOIN applicant_source_intents intent ON intent.sequence = application.root_intent_sequence
        WHERE application.closed_at IS NULL AND application.settled_at IS NOT NULL
        ORDER BY application.last_checked_at NULLS FIRST, application.created_at
        LIMIT $1
        FOR NO KEY UPDATE OF application SKIP LOCKED`,
      [input.batch ?? 50]
    );
    for (const application of picked.rows) {
      // Bumped outside the savepoint, so a failing application still moves
      // to the back of the queue and cannot starve the rest.
      await client.query(
        "UPDATE applicant_source_applications SET last_checked_at = now() WHERE id = $1",
        [application.id]
      );
      const local = emptyCounts();
      await client.query("SAVEPOINT application");
      try {
        await linkApplication(client, input, application, now, local);
        await client.query("RELEASE SAVEPOINT application");
        addCounts(counts, local);
      } catch {
        // Count only: an error message can carry identities.
        await client.query("ROLLBACK TO SAVEPOINT application");
        counts.failed++;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return counts;
}

/**
 * Hourly, whatever the linking flag says: closes applications that never
 * settled within 30 days, and deletes closed ones 30 days on.
 */
export async function closeStaleApplicantApplications(
  pool: Pool,
  now = new Date()
): Promise<{ expired: number; deleted: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One transaction: a closed application never keeps its member rows.
    const stale = await client.query<{ id: string }>(
      `UPDATE applicant_source_applications application
          SET closed_at = $1::timestamptz,
              expired_count = expired_count + (
                SELECT count(*) FROM applicant_source_application_members m
                 WHERE m.application_id = application.id AND m.outcome IS NULL)
        WHERE closed_at IS NULL AND created_at <= $1::timestamptz - interval '30 days'
        RETURNING id`,
      [now]
    );
    if (stale.rowCount)
      await client.query(
        "DELETE FROM applicant_source_application_members WHERE application_id = ANY($1)",
        [stale.rows.map((row) => row.id)]
      );
    const deleted = await client.query(
      "DELETE FROM applicant_source_applications WHERE closed_at <= $1::timestamptz - interval '30 days'",
      [now]
    );
    await client.query("COMMIT");
    return { expired: stale.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
