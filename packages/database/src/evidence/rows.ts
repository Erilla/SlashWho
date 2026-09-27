import { parsePerformanceValues } from "../mappers";
import type { Queryable } from "../sql";

type EvidenceRowColumn<Row> = readonly [
  name: string,
  type: string,
  value: (row: Row) => unknown
];

// Inserts every row for one evidence run in a single statement. Each column
// travels as one typed array and `unnest` zips the arrays back into rows, so
// the statement and its parameter count stay the same size however long the
// history is.
export async function insertEvidenceRows<Row>(
  client: Queryable,
  table: string,
  runId: string,
  columns: readonly EvidenceRowColumn<Row>[],
  rows: readonly Row[]
): Promise<void> {
  if (rows.length === 0) return;
  const names = columns.map(([name]) => name).join(", ");
  await client.query(
    `INSERT INTO ${table} (evidence_run_id, ${names})
     SELECT $1::uuid, item.*
       FROM unnest(${columns
         .map(([, type], index) => `$${index + 2}::${type}[]`)
         .join(", ")}) AS item(${names})`,
    [runId, ...columns.map(([, , value]) => rows.map(value))]
  );
}

// The spec and three parse metrics shared by a kill and a tier best.
export function performanceColumns<
  Row extends { performance: ReturnType<typeof parsePerformanceValues> }
>(): EvidenceRowColumn<Row>[] {
  return [
    ["spec_name", "text", ({ performance }) => performance.spec?.name ?? null],
    [
      "spec_icon_url",
      "text",
      ({ performance }) => performance.spec?.iconUrl ?? null
    ],
    [
      "damage_parse_state",
      "character_mythic_kill_parse_state",
      ({ performance }) => performance.damage.state
    ],
    [
      "damage_percentile",
      "double precision",
      ({ performance }) => performance.damage.percentile
    ],
    [
      "healing_parse_state",
      "character_mythic_kill_parse_state",
      ({ performance }) => performance.healing.state
    ],
    [
      "healing_percentile",
      "double precision",
      ({ performance }) => performance.healing.percentile
    ],
    [
      "boss_damage_parse_state",
      "character_mythic_kill_parse_state",
      ({ performance }) => performance.bossDamage.state
    ],
    [
      "boss_damage_percentile",
      "double precision",
      ({ performance }) => performance.bossDamage.percentile
    ]
  ];
}
