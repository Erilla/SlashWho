import type { GuildTimelineSpan, RaidTier } from "@slashwho/domain";

export type GuildTimelineBar = GuildTimelineSpan &
  Readonly<{
    x: number;
    width: number;
    lane: number;
    /** Whether the guild's name fits on the bar, or sits just to its right. */
    labelInside: boolean;
  }>;

export type GuildTimelineLayout = Readonly<{
  bars: readonly GuildTimelineBar[];
  lanes: number;
  /** The drawing's full width, which the timeline scrolls across. */
  width: number;
  /** The first day drawn, `YYYY-MM-DD`. */
  startsOn: string;
  /** The last day drawn, `YYYY-MM-DD`. */
  endsOn: string;
  /** Where a `YYYY-MM-DD` day falls, in pixels from the left edge. */
  x: (date: string) => number;
}>;

export type GuildTimelineLayoutOptions = Readonly<{
  /** Today, so the timeline runs to the present rather than the last night. */
  today: string;
  pixelsPerYear: number;
  /** The width a guild's name takes when drawn. */
  labelWidth: (text: string) => number;
  padding?: number;
}>;

export type GuildTimelineTierBand = Readonly<{
  tier: RaidTier;
  /** The first day of the band drawn, clipped to the axis. */
  from: string;
  /** The day after the band ends: the next tier's opening, or the axis end. */
  to: string;
  /**
   * Alternates tier by tier across the whole schedule, so a band keeps its
   * shade however far back the axis happens to start.
   */
  shaded: boolean;
}>;

/**
 * The stretch of axis each tier covers, from its opening to the next tier's.
 * The tier already under way when the axis starts is clipped to the axis
 * rather than left out, so the background has no unbanded gap.
 */
export function tierBands(
  tiers: readonly RaidTier[],
  startsOn: string,
  endsOn: string
): GuildTimelineTierBand[] {
  return tiers.flatMap((tier, index) => {
    const next = tiers[index + 1]?.startsOn ?? endsOn;
    const from = tier.startsOn > startsOn ? tier.startsOn : startsOn;
    const to = next < endsOn ? next : endsOn;
    return from < to ? [{ tier, from, to, shaded: index % 2 === 1 }] : [];
  });
}

const DAY_MS = 24 * 60 * 60_000;
const YEAR_MS = 365.25 * DAY_MS;
// Room either side of a bar so labels and neighbours never touch.
const MINIMUM_BAR_WIDTH = 4;
const LABEL_INSET = 6;
const LANE_GAP = 8;
const TODAY_MARKER_ROOM = 48;

function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/**
 * Where each stretch is drawn. The axis starts on 1 January of the first
 * year with a night and ends on 1 January after today. Each bar takes the
 * highest row with room for it and its label, so overlapping guilds get rows
 * of their own while a guild that follows another shares its row.
 */
export function layoutGuildTimeline(
  spans: readonly GuildTimelineSpan[],
  options: GuildTimelineLayoutOptions
): GuildTimelineLayout {
  const padding = options.padding ?? 8;
  const firstYear = Math.min(
    ...spans.map((span) => Number(span.firstNight.slice(0, 4))),
    Number(options.today.slice(0, 4))
  );
  const startsOn = `${firstYear}-01-01`;
  const endsOn = `${Number(options.today.slice(0, 4)) + 1}-01-01`;
  const origin = dayMs(startsOn);
  const x = (date: string) =>
    padding + ((dayMs(date) - origin) / YEAR_MS) * options.pixelsPerYear;
  const laneEnds: number[] = [];
  const bars = spans.map((span): GuildTimelineBar => {
    const start = x(span.firstNight);
    // A bar covers its last night, so it ends the following day.
    const width = Math.max(
      MINIMUM_BAR_WIDTH,
      x(span.lastNight) + options.pixelsPerYear / 365.25 - start
    );
    const labelWidth = options.labelWidth(span.guild.name);
    const labelInside = width >= labelWidth + LABEL_INSET * 2;
    const end =
      (labelInside ? start + width : start + width + LABEL_INSET + labelWidth) +
      LANE_GAP;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    return { ...span, x: start, width, lane, labelInside };
  });
  return {
    bars,
    lanes: Math.max(1, laneEnds.length),
    // Room past today for the markers of guilds held now, which sit just
    // right of the present even in late December.
    width: Math.ceil(
      Math.max(x(endsOn), x(options.today) + TODAY_MARKER_ROOM, ...laneEnds) +
        padding
    ),
    startsOn,
    endsOn,
    x
  };
}
