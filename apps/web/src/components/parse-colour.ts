export type ParseColour =
  "grey" | "green" | "blue" | "purple" | "orange" | "pink" | "gold";

export function parseColour(percentile: number): ParseColour {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100)
    throw new RangeError("parse_percentile_out_of_range");
  if (percentile < 25) return "grey";
  if (percentile < 50) return "green";
  if (percentile < 75) return "blue";
  if (percentile < 95) return "purple";
  if (percentile < 99) return "orange";
  if (percentile < 100) return "pink";
  return "gold";
}
