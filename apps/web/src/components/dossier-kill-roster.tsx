import type { DossierKillRoster as Roster } from "@slashwho/contracts";

import { classColourModifier } from "./dossier-character-name";

type AvailableRoster = Extract<Roster, { state: "available" }>;
type RosterRole = AvailableRoster["members"][number]["role"];

const unavailableReason: Readonly<
  Record<Extract<Roster, { state: "unavailable" }>["reason"], string>
> = {
  private: "The guild has hidden this raid's roster on Raider.IO.",
  no_logged_encounter: "Raider.IO has no logged encounter of this kill.",
  not_read: "Raider.IO's logged encounter has not been read yet."
};

const roleLabel: Readonly<Record<RosterRole, string>> = {
  tank: "Tank",
  healer: "Healer",
  dps: "DPS"
};

function counted(count: number, one: string): string {
  return `${String(count)} ${count === 1 ? one : `${one}s`}`;
}

function itemLevel(value: number): string {
  return value.toFixed(1);
}

function fightLength(durationMs: number): string {
  const seconds = Math.round(durationMs / 1_000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Realm slugs as the realm reads: `twisting-nether` is Twisting Nether. */
function realmName(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function sameRealm(a: string, b: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return fold(a) === fold(b);
}

/** The roster's one summary line: size, roles, item level, and the fight. */
export function rosterSummary(roster: AvailableRoster): string {
  const { tank, healer, dps } = roster.roleCounts;
  return [
    counted(roster.playerCount, "player"),
    `${counted(tank, "tank")}, ${counted(healer, "healer")}, ${String(dps)} DPS`,
    `item level ${itemLevel(roster.itemLevel.average)} (${itemLevel(roster.itemLevel.min)}–${itemLevel(roster.itemLevel.max)})`,
    `pulled ${new Date(roster.pulledAt).toISOString().slice(11, 16)} UTC`,
    `${fightLength(roster.durationMs)} fight`,
    counted(roster.deathCount, "death"),
    // Null is Raider.IO giving no Vantus data (#747): left out, never "0".
    ...(roster.vantusCount === null
      ? []
      : [counted(roster.vantusCount, "Vantus rune")])
  ].join(" · ");
}

function RoleIcon({ role }: { role: RosterRole }) {
  const label = roleLabel[role];
  return (
    <svg
      aria-label={label}
      className={`dossier-roster-role dossier-roster-role--${role}`}
      fill="none"
      role="img"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 20 20"
    >
      <title>{label}</title>
      {role === "tank" ? (
        <path d="M10 2 4 5v5c0 4 3 7 6 8 3-1 6-4 6-8V5z" />
      ) : role === "healer" ? (
        <path d="M10 4v12M4 10h12" />
      ) : (
        <path d="m4 16 9-9M12 4l4 4-2 2-4-4z" />
      )}
    </svg>
  );
}

/**
 * Who was in the raid, from Raider.IO's logged encounter of the kill (#732).
 * An unavailable roster says why, and is never drawn as an empty table: that
 * would read as "nobody was there".
 */
export function DossierKillRoster({
  roster,
  guildRealm
}: {
  roster: Roster;
  /** The kill guild's realm; a raider on it shows no realm of their own. */
  guildRealm: string | null;
}) {
  if (roster.state === "unavailable") {
    return (
      <div className="dossier-roster-unavailable">
        <p>Roster unavailable</p>
        <p>{unavailableReason[roster.reason]}</p>
      </div>
    );
  }
  return (
    <div className="dossier-roster">
      <p className="dossier-roster-summary">{rosterSummary(roster)}</p>
      <table aria-label="Raid roster" className="dossier-roster-table">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Character</th>
            <th scope="col">Class</th>
            <th scope="col">Realm</th>
            <th scope="col">Item level</th>
          </tr>
        </thead>
        <tbody>
          {roster.members.map((member) => {
            const modifier = classColourModifier(member.className);
            return (
              <tr
                className={
                  member.isDossierCharacter
                    ? "dossier-roster-row dossier-roster-row--connected"
                    : "dossier-roster-row"
                }
                key={`${member.region}/${member.realm}/${member.name}`}
              >
                <td>
                  <RoleIcon role={member.role} />
                </td>
                <td>
                  <span
                    className={
                      modifier
                        ? `dossier-character-name dossier-character-name--${modifier}`
                        : "dossier-character-name"
                    }
                  >
                    {member.name}
                  </span>
                  {member.isDossierCharacter ? (
                    <span className="dossier-roster-connected">
                      Connected character
                    </span>
                  ) : null}
                </td>
                <td>{member.className}</td>
                <td>
                  {guildRealm !== null && sameRealm(member.realm, guildRealm)
                    ? null
                    : realmName(member.realm)}
                </td>
                <td>
                  {member.itemLevel === null
                    ? "—"
                    : itemLevel(member.itemLevel)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
