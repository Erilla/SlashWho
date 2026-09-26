import type { ApplicantDossier } from "@slashwho/contracts";
import {
  formatCharacterDisplayName,
  guildIdentity,
  guildTimelineSpans,
  raidTiers
} from "@slashwho/domain";
import { useEffect, useMemo, useRef, useState } from "react";

import type { EvidenceFilter } from "../lib/character-visibility";
import {
  layoutGuildTimeline,
  type GuildTimelineBar
} from "../lib/guild-timeline-layout";

type DossierGuildHistoryProps = Readonly<{
  guildHistory: NonNullable<ApplicantDossier["guildHistory"]>;
  characters: ApplicantDossier["characters"];
  filter?: EvidenceFilter | null;
  /** Today, `YYYY-MM-DD`; injectable so tests do not depend on the clock. */
  today?: string;
}>;

const PIXELS_PER_YEAR = 120;
const LANE_HEIGHT = 28;
const BAR_HEIGHT = 20;
const TOP = 8;
const AXIS_HEIGHT = 22;
// Bar labels are 12px; this over-estimates a little so a label never spills
// into the next bar in its row.
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

type Tooltip = Readonly<{ lines: readonly string[]; x: number; y: number }>;

export function DossierGuildHistory({
  guildHistory,
  characters,
  filter = null,
  today = new Date().toISOString().slice(0, 10)
}: DossierGuildHistoryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const layout = useMemo(() => {
    const spans = guildTimelineSpans(guildHistory, {
      tiers,
      ...(filter ? { isCharacterVisible: filter.isCharacterVisible } : {})
    });
    return spans.length === 0
      ? null
      : layoutGuildTimeline(spans, {
          today,
          pixelsPerYear: PIXELS_PER_YEAR,
          labelWidth: (text) => text.length * CHARACTER_WIDTH
        });
  }, [guildHistory, tiers, filter, today]);

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
  }, [width]);

  const height = layout ? TOP + layout.lanes * LANE_HEIGHT + AXIS_HEIGHT : 0;
  const laneY = (lane: number) => TOP + lane * LANE_HEIGHT;
  const lastLane = new Map<string, number>();
  for (const bar of layout?.bars ?? []) lastLane.set(bar.guildId, bar.lane);
  const ringsInLane = new Map<number, number>();
  const years = layout
    ? Array.from(
        {
          length:
            Number(layout.endsOn.slice(0, 4)) -
            Number(layout.startsOn.slice(0, 4))
        },
        (_, index) => Number(layout.startsOn.slice(0, 4)) + index
      )
    : [];
  const visibleTiers = layout
    ? tiers.filter(
        (tier) => tier.startsOn > layout.startsOn && tier.startsOn < today
      )
    : [];
  // The tooltip sits outside the scroller so a short timeline cannot clip
  // it, which means placing it against what is scrolled into view.
  const showTooltip = (lines: readonly string[], x: number, y: number) => {
    const scroll = scrollRef.current;
    const left = x - (scroll?.scrollLeft ?? 0);
    const visibleWidth = scroll?.clientWidth ?? width;
    setTooltip({
      lines,
      x: Math.max(0, Math.min(left, visibleWidth - TOOLTIP_WIDTH)),
      y
    });
  };

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
            onScroll={() => setTooltip(null)}
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
                {visibleTiers.map((tier) => {
                  const x = layout.x(tier.startsOn);
                  return (
                    <g
                      aria-hidden="true"
                      className="dossier-guild-timeline-tier"
                      key={tier.startsOn}
                      onMouseEnter={() =>
                        showTooltip(
                          [
                            `Tier: ${tier.name}`,
                            `Opened ${formatDay(tier.startsOn)}`
                          ],
                          x + 6,
                          TOP
                        )
                      }
                    >
                      <line
                        x1={x}
                        x2={x}
                        y1={0}
                        y2={height - AXIS_HEIGHT + 4}
                      />
                      <rect
                        fill="transparent"
                        height={height - AXIS_HEIGHT + 4}
                        width={8}
                        x={x - 4}
                        y={0}
                      />
                    </g>
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
                {layout.bars.map((bar) => {
                  const y = laneY(bar.lane) + (LANE_HEIGHT - BAR_HEIGHT) / 2;
                  const lines = describeBar(bar);
                  return (
                    <g
                      aria-label={lines.join(". ")}
                      className="dossier-guild-timeline-bar"
                      key={`${bar.guildId}-${bar.firstNight}`}
                      onBlur={() => setTooltip(null)}
                      onFocus={() =>
                        showTooltip(lines, bar.x, y + BAR_HEIGHT + 4)
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
                      <text
                        aria-hidden="true"
                        className={
                          bar.labelInside
                            ? "dossier-guild-timeline-label"
                            : "dossier-guild-timeline-label dossier-guild-timeline-label--outside"
                        }
                        x={bar.labelInside ? bar.x + 6 : bar.x + bar.width + 6}
                        y={y + 14}
                      >
                        {bar.guild.name}
                      </text>
                    </g>
                  );
                })}
                {[...current].flatMap(([guildId, count]) => {
                  const lane = lastLane.get(guildId);
                  if (lane === undefined) return [];
                  // Two current guilds whose histories end in the same row
                  // sit side by side rather than on top of each other.
                  const inLane = ringsInLane.get(lane) ?? 0;
                  ringsInLane.set(lane, inLane + 1);
                  const x = layout.x(today) + 10 + inLane * 14;
                  const cy = laneY(lane) + LANE_HEIGHT / 2;
                  const guild = layout.bars.find(
                    (bar) => bar.guildId === guildId
                  )!.guild;
                  const lines = [
                    `${guild.name} today`,
                    `${plural(count, "character")} in the latest snapshot`
                  ];
                  return [
                    <g
                      aria-label={lines.join(". ")}
                      className="dossier-guild-timeline-current"
                      key={guildId}
                      onBlur={() => setTooltip(null)}
                      onFocus={() => showTooltip(lines, x - 120, cy + 12)}
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
                    </g>
                  ];
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
                  <strong key={line}>{line}</strong>
                ) : (
                  <span key={line}>{line}</span>
                )
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
