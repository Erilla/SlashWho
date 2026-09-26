import type { ApplicantDossier } from "@slashwho/contracts";
import {
  formatCharacterDisplayName,
  guildIdentity,
  guildTimelineSpans,
  raidTiers
} from "@slashwho/domain";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";

import type { EvidenceFilter } from "../lib/character-visibility";
import { DossierCharacterLabels } from "./dossier-character-name";
import {
  layoutGuildTimeline,
  tierBands,
  type GuildTimelineBar
} from "../lib/guild-timeline-layout";

type DossierGuildHistoryProps = Readonly<{
  guildHistory: NonNullable<ApplicantDossier["guildHistory"]>;
  characters: ApplicantDossier["characters"];
  filter?: EvidenceFilter | null;
  /** Today, `YYYY-MM-DD`; injectable so tests do not depend on the clock. */
  today?: string;
}>;

// A year's label needs about this much room; below it the timeline scrolls.
const MINIMUM_PIXELS_PER_YEAR = 100;
const LANE_HEIGHT = 28;
const BAR_HEIGHT = 20;
const TOP = 8;
const AXIS_HEIGHT = 22;
// Bar labels are 12px; this over-estimates a little so a label is shortened
// before it reaches its bar's end. Each label is also clipped to its bar, so
// an unusually wide name cannot spill out regardless.
const CHARACTER_WIDTH = 7;
// Matches the tooltip's max-width, 15rem, so it is kept inside the frame.
const TOOLTIP_WIDTH = 240;

// Categorical, in a fixed order, so a guild keeps its colour however the
// viewer filters: colours are assigned by first appearance in the whole
// history, not in what is currently visible.
const GUILD_COLOURS = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#9085e9",
  "#e66767",
  "#5fa33a"
];

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC"
});

function formatDay(date: string): string {
  return dateFormat.format(new Date(`${date}T00:00:00.000Z`));
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeBar(bar: GuildTimelineBar): string[] {
  return [
    bar.guild.name,
    bar.firstNight === bar.lastNight
      ? formatDay(bar.firstNight)
      : `${formatDay(bar.firstNight)} to ${formatDay(bar.lastNight)}`,
    `${plural(bar.nights, "raid night")}: ${bar.characters
      .map((character) => formatCharacterDisplayName(character.name))
      .join(", ")}`,
    ...(bar.tiers.length > 0 ? [bar.tiers.join(", ")] : [])
  ];
}

/** The bar's description as the tooltip shows it, names in class colours. */
function barTooltipLines(bar: GuildTimelineBar): ReactNode[] {
  const [guild, dates, , ...tiers] = describeBar(bar);
  return [
    guild,
    dates,
    <>
      {plural(bar.nights, "raid night")}:{" "}
      <DossierCharacterLabels characters={bar.characters} />
    </>,
    ...tiers
  ];
}

type Tooltip = Readonly<{
  lines: readonly ReactNode[];
  /** Where it points, in pixels from the timeline's left edge. */
  anchor: number;
  /** Where it is drawn, against what is scrolled into view. */
  x: number;
  y: number;
  /** Shown by keyboard focus, so it follows its bar through a scroll. */
  focused: boolean;
}>;

export function DossierGuildHistory({
  guildHistory,
  characters,
  filter = null,
  today = new Date().toISOString().slice(0, 10)
}: DossierGuildHistoryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Clip-path ids are document-wide, so they carry an id unique to this
  // instance; useId's colons are not valid in a url(#...) reference.
  const clipPrefix = `guild-label-${useId().replace(/:/g, "")}`;
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const tiers = useMemo(() => raidTiers(), []);
  // Assigned over every character's history rather than what is visible, so
  // hiding a character never repaints the guilds that remain; and over drawn
  // guilds only, so one-night guilds do not use up the palette's first hues.
  const colours = useMemo(() => {
    const order = [
      ...new Set(
        guildTimelineSpans(guildHistory, { tiers }).map((span) => span.guildId)
      )
    ];
    return new Map(
      order.map((guildId, index) => [
        guildId,
        GUILD_COLOURS[index % GUILD_COLOURS.length]!
      ])
    );
  }, [guildHistory, tiers]);
  // The width the timeline has to fill, so a short history stretches across
  // the section instead of stopping part-way along it.
  const [fitWidth, setFitWidth] = useState(0);
  const layout = useMemo(() => {
    const spans = guildTimelineSpans(guildHistory, {
      tiers,
      ...(filter ? { isCharacterVisible: filter.isCharacterVisible } : {})
    });
    return spans.length === 0
      ? null
      : layoutGuildTimeline(spans, {
          today,
          minimumPixelsPerYear: MINIMUM_PIXELS_PER_YEAR,
          fitWidth,
          labelWidth: (text) => text.length * CHARACTER_WIDTH
        });
  }, [guildHistory, tiers, filter, today, fitWidth]);
  const hasLayout = layout !== null;
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const measure = () => setFitWidth(scroll.clientWidth);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [hasLayout]);

  // The guilds the latest snapshot places the visible characters in, marked
  // at the present on the row where that guild's history ends.
  const current = useMemo(() => {
    const counts = new Map<string, number>();
    for (const character of characters) {
      if (character.excluded || !character.guild) continue;
      if (filter && !filter.isCharacterVisible(character.key)) continue;
      const id = guildIdentity(character.guild);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [characters, filter]);

  // The present is what a reviewer came to see, so the timeline opens there.
  const width = layout?.width ?? 0;
  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollLeft = scroll.scrollWidth;
  }, [width, fitWidth]);

  // Bars are laid out oldest first, so the last seen in a row ends it.
  const lastBar = new Map<string, GuildTimelineBar>();
  const endsRow = new Map<number, string>();
  for (const bar of layout?.bars ?? []) {
    lastBar.set(bar.guildId, bar);
    endsRow.set(bar.lane, bar.guildId);
  }
  // A current guild's ring sits at the end of the row its history ends in.
  // If a later guild has since taken that row, a ring there would read as
  // the later guild's, so it gets a row of its own, named.
  let extraLanes = 0;
  const rings = [...current].flatMap(([guildId, count]) => {
    const bar = lastBar.get(guildId);
    if (!bar || !layout) return [];
    const ownsRow = endsRow.get(bar.lane) === guildId;
    return [
      {
        guildId,
        guild: bar.guild,
        count,
        lane: ownsRow ? bar.lane : layout.lanes + extraLanes++,
        labelled: !ownsRow
      }
    ];
  });
  const height = layout
    ? TOP + (layout.lanes + extraLanes) * LANE_HEIGHT + AXIS_HEIGHT
    : 0;
  const laneY = (lane: number) => TOP + lane * LANE_HEIGHT;
  // Every year that opens on the axis, the current one included.
  const years = layout
    ? Array.from(
        {
          length:
            Number(layout.endsOn.slice(0, 4)) -
            Number(layout.startsOn.slice(0, 4)) +
            1
        },
        (_, index) => Number(layout.startsOn.slice(0, 4)) + index
      ).filter((year) => `${year}-01-01` < layout.endsOn)
    : [];
  const bands = layout ? tierBands(tiers, layout.startsOn, layout.endsOn) : [];
  const visibleTiers = layout
    ? tiers.filter(
        (tier) => tier.startsOn > layout.startsOn && tier.startsOn < today
      )
    : [];
  // The tooltip sits outside the scroller so a short timeline cannot clip
  // it, which means placing it against what is scrolled into view.
  const place = (anchor: number) => {
    const scroll = scrollRef.current;
    const left = anchor - (scroll?.scrollLeft ?? 0);
    const visibleWidth = scroll?.clientWidth ?? width;
    return Math.max(0, Math.min(left, visibleWidth - TOOLTIP_WIDTH));
  };
  const showTooltip = (
    lines: readonly ReactNode[],
    anchor: number,
    y: number,
    focused = false
  ) => setTooltip({ lines, anchor, x: place(anchor), y, focused });
  // Focusing an off-screen bar makes the browser scroll it into view, and
  // that scroll arrives after `focus`: a focused tooltip is moved with its
  // bar rather than hidden. A hovered one would be left pointing at
  // whatever scrolled under the pointer, so it goes.
  const onScroll = () =>
    setTooltip((shown) =>
      shown?.focused ? { ...shown, x: place(shown.anchor) } : null
    );

  return (
    <section
      aria-labelledby="guild-history-heading"
      className="dossier-panel dossier-guild-history-panel"
    >
      <h2 className="section-heading" id="guild-history-heading">
        Guild history
      </h2>
      <p className="empty-state">
        Raid nights on guild logs, from every character shown. A bar breaks
        where a whole tier passed without one.
      </p>
      {!layout ? (
        <p className="empty-state">
          No guild has more than one raid night in the stored evidence.
        </p>
      ) : (
        <div className="dossier-guild-timeline-frame">
          <div
            aria-label="Guild history timeline, scrolls horizontally"
            className="dossier-guild-timeline-scroll"
            onScroll={onScroll}
            ref={scrollRef}
            role="region"
            tabIndex={0}
          >
            <div
              className="dossier-guild-timeline"
              style={{ width: `${layout.width}px`, height: `${height}px` }}
            >
              <svg
                aria-label="Guild history bars"
                height={height}
                role="group"
                onMouseLeave={() => setTooltip(null)}
                viewBox={`0 0 ${layout.width} ${height}`}
                width={layout.width}
              >
                {bands.map((band) => {
                  const x = layout.x(band.from);
                  return (
                    <rect
                      aria-hidden="true"
                      className={
                        band.shaded
                          ? "dossier-guild-timeline-band dossier-guild-timeline-band--shaded"
                          : "dossier-guild-timeline-band"
                      }
                      height={height - AXIS_HEIGHT + 4}
                      key={band.tier.startsOn}
                      onMouseEnter={(event) =>
                        showTooltip(
                          [
                            `Tier: ${band.tier.name}`,
                            `Opened ${formatDay(band.tier.startsOn)}`
                          ],
                          // Beside the pointer: a band can be wider than the
                          // view, so its start may be scrolled out of sight.
                          event.clientX -
                            (event.currentTarget.ownerSVGElement?.getBoundingClientRect()
                              .left ?? 0) +
                            8,
                          TOP
                        )
                      }
                      width={layout.x(band.to) - x}
                      x={x}
                      y={0}
                    />
                  );
                })}
                {visibleTiers.map((tier) => {
                  const x = layout.x(tier.startsOn);
                  return (
                    <line
                      aria-hidden="true"
                      className="dossier-guild-timeline-tier"
                      key={tier.startsOn}
                      x1={x}
                      x2={x}
                      y1={0}
                      y2={height - AXIS_HEIGHT + 4}
                    />
                  );
                })}
                {years.map((year) => {
                  const x = layout.x(`${year}-01-01`);
                  return (
                    <g
                      aria-hidden="true"
                      className="dossier-guild-timeline-year"
                      key={year}
                    >
                      <line
                        x1={x}
                        x2={x}
                        y1={height - AXIS_HEIGHT + 2}
                        y2={height - AXIS_HEIGHT + 8}
                      />
                      <text x={x + 4} y={height - 4}>
                        {year}
                      </text>
                    </g>
                  );
                })}
                {layout.bars.map((bar, index) => {
                  const y = laneY(bar.lane) + (LANE_HEIGHT - BAR_HEIGHT) / 2;
                  const lines = barTooltipLines(bar);
                  return (
                    <g
                      aria-label={describeBar(bar).join(". ")}
                      className="dossier-guild-timeline-bar"
                      key={`${bar.guildId}-${bar.firstNight}`}
                      onBlur={() => setTooltip(null)}
                      onFocus={() =>
                        showTooltip(lines, bar.x, y + BAR_HEIGHT + 4, true)
                      }
                      onMouseEnter={() =>
                        showTooltip(lines, bar.x, y + BAR_HEIGHT + 4)
                      }
                      role="img"
                      tabIndex={0}
                    >
                      <rect
                        fill={colours.get(bar.guildId)}
                        height={BAR_HEIGHT}
                        rx={3}
                        width={bar.width}
                        x={bar.x}
                        y={y}
                      />
                      {bar.label ? (
                        <>
                          <clipPath id={`${clipPrefix}-${index}`}>
                            <rect
                              height={BAR_HEIGHT}
                              width={bar.width}
                              x={bar.x}
                              y={y}
                            />
                          </clipPath>
                          <text
                            aria-hidden="true"
                            className="dossier-guild-timeline-label"
                            clipPath={`url(#${clipPrefix}-${index})`}
                            x={bar.x + 6}
                            y={y + 14}
                          >
                            {bar.label}
                          </text>
                        </>
                      ) : null}
                    </g>
                  );
                })}
                {rings.map(({ guildId, guild, count, lane, labelled }) => {
                  const x = layout.x(today) + 10;
                  const cy = laneY(lane) + LANE_HEIGHT / 2;
                  const lines = [
                    `${guild.name} today`,
                    `${plural(count, "character")} in the latest snapshot`
                  ];
                  return (
                    <g
                      aria-label={lines.join(". ")}
                      className="dossier-guild-timeline-current"
                      key={guildId}
                      onBlur={() => setTooltip(null)}
                      onFocus={() => showTooltip(lines, x - 120, cy + 12, true)}
                      onMouseEnter={() => showTooltip(lines, x - 120, cy + 12)}
                      role="img"
                      tabIndex={0}
                    >
                      <circle
                        cx={x}
                        cy={cy}
                        r={5}
                        stroke={colours.get(guildId)}
                      />
                      {labelled ? (
                        <text
                          aria-hidden="true"
                          className="dossier-guild-timeline-ring-label"
                          textAnchor="end"
                          x={x - 10}
                          y={cy + 4}
                        >
                          {guild.name}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
          {tooltip ? (
            <div
              aria-hidden="true"
              className="dossier-guild-timeline-tooltip"
              style={{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }}
            >
              {tooltip.lines.map((line, index) =>
                index === 0 ? (
                  <strong key={index}>{line}</strong>
                ) : (
                  <span key={index}>{line}</span>
                )
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
