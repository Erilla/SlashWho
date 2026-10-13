/** More links than this in one response looks like more than one person's. */
export const applicationLinkCap = 5;

export type IntakeRow = {
  /** Sheet row number, for alerts only; never stored. */
  row: number;
  submittedSerial: number | undefined;
  /** Accepted candidate identities, in cell order, de-duplicated. */
  identities: readonly string[];
};

/**
 * The response an identity's new root occurrence came from. Rows are chosen by
 * the Forms timestamp, never by position, so a sorted or edited sheet cannot
 * attach one applicant's characters to another's response.
 */
export function chooseApplicationRow(input: {
  rows: readonly IntakeRow[];
  rootIdentity: string;
  carriedMark: number;
  lastApplicationSerial: number | undefined;
}): { row: IntakeRow | undefined; ambiguous: number } {
  const floor = Math.max(
    input.carriedMark,
    input.lastApplicationSerial ?? Number.NEGATIVE_INFINITY
  );
  const candidates = input.rows.filter(
    (row) =>
      row.identities[0] === input.rootIdentity &&
      row.submittedSerial !== undefined &&
      row.submittedSerial > floor
  );
  if (candidates.length === 0) return { row: undefined, ambiguous: 0 };
  const newest = candidates.reduce((best, row) =>
    row.submittedSerial! > best.submittedSerial! ? row : best
  );
  return { row: newest, ambiguous: candidates.length - 1 };
}
