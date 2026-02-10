import { X } from "lucide-react";
import clsx from "clsx";
import { daysInData, layoutEventsByDay } from "../lib/layout";
import { formatMinutes } from "../lib/time";
import { courseToColor, hexToRgba } from "../lib/colors";
import type { ClassEvent, PositionedEvent } from "../lib/types";

type Props = {
  events: ClassEvent[];
  selected: Set<string>;
  onDeselect: (id: string) => void;
};

const PX_PER_MIN = 1.2; // 72px per hour

export function Timetable({ events, selected, onDeselect }: Props) {
  const selectedEvents = events.filter((e) => selected.has(e.id));
  const days = daysInData(events);
  const byDay = layoutEventsByDay(selectedEvents);

  // Fixed visible range: 08:00–20:00
  const start = 8 * 60;
  const end = 20 * 60;

  const heightPx = Math.max(1, (end - start) * PX_PER_MIN);

  const hours: number[] = [];
  for (let t = start; t <= end; t += 60) hours.push(t);

  return (
    <div className="flex-1 overflow-auto">
      <div className="min-w-[900px] p-5">
        {/* Minimal header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-white/80">Timetable</div>
          <div className="text-xs text-white/50 tabular-nums font-mono">
            {formatMinutes(start)}–{formatMinutes(end)}
          </div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
          {/* Header row */}
          <div
            className="grid border-b border-white/10"
            style={{ gridTemplateColumns: `80px repeat(${days.length}, minmax(0, 1fr))` }}
          >
            <div className="px-4 py-2 text-[11px] font-semibold text-white/45">Time</div>
            {days.map((d) => (
              <div key={d} className="px-4 py-2 text-[11px] font-semibold text-white/65">
                {d}
              </div>
            ))}
          </div>

          {/* Body */}
          <div
            className="grid"
            style={{ gridTemplateColumns: `80px repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {/* Time labels */}
            <div className="relative border-r border-white/10" style={{ height: heightPx }}>
              {hours.map((t) => {
                const top = (t - start) * PX_PER_MIN;
                return (
                  <div
                    key={t}
                    className="absolute left-0 right-0 -translate-y-1/2 px-4 text-[11px] font-medium text-white/45 tabular-nums font-mono"
                    style={{ top }}
                  >
                    {formatMinutes(t)}
                  </div>
                );
              })}
            </div>

            {days.map((d) => (
              <DayColumn
                key={d}
                events={byDay[d] ?? []}
                start={start}
                heightPx={heightPx}
                onDeselect={onDeselect}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  events,
  start,
  heightPx,
  onDeselect,
}: {
  events: PositionedEvent[];
  start: number;
  heightPx: number;
  onDeselect: (id: string) => void;
}) {
  return (
    <div className="relative border-r border-white/10" style={{ height: heightPx }}>
      {/* Clean grid: minor 30-min lines + major hourly lines */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: [
            // minor 30-min
            `repeating-linear-gradient(to bottom,
              transparent 0,
              transparent ${30 * PX_PER_MIN - 1}px,
              rgba(255,255,255,0.03) ${30 * PX_PER_MIN - 1}px,
              rgba(255,255,255,0.03) ${30 * PX_PER_MIN}px
            )`,
            // major hour
            `repeating-linear-gradient(to bottom,
              transparent 0,
              transparent ${60 * PX_PER_MIN - 1}px,
              rgba(255,255,255,0.07) ${60 * PX_PER_MIN - 1}px,
              rgba(255,255,255,0.07) ${60 * PX_PER_MIN}px
            )`,
          ].join(", "),
        }}
      />

      {events.map((e) => (
        <EventCard key={e.id} e={e} start={start} onDeselect={onDeselect} />
      ))}
    </div>
  );
}

function EventCard({
  e,
  start,
  onDeselect,
}: {
  e: PositionedEvent;
  start: number;
  onDeselect: (id: string) => void;
}) {
  const top = (e.startMin - start) * PX_PER_MIN;
  const height = Math.max(18, (e.endMin - e.startMin) * PX_PER_MIN);

  const leftPct = (e.col / e.cols) * 100;
  const widthPct = 100 / e.cols;
  const gap = 12;

  const isTiny = height < 42; // tooltip threshold
  const tooltip = `${e.courseCode} ${e.classCode}\n${formatMinutes(e.startMin)}–${formatMinutes(
    e.endMin
  )}\n${e.location}`;

  // Muted course tint + accent stripe
  const accent = courseToColor(e.courseCode);
  const bg = hexToRgba(accent, 0.14);
  const border = hexToRgba(accent, 0.45);

  return (
    <div
      title={isTiny ? tooltip : undefined}
      className={clsx(
        "group absolute overflow-hidden rounded-2xl px-3 py-2 text-white",
        "border bg-white/5 backdrop-blur-md",
        "shadow-[0_10px_26px_rgba(0,0,0,0.30)]",
        "hover:bg-white/7"
      )}
      style={{
        top,
        height,
        left: `calc(${leftPct}% + ${gap / 2}px)`,
        width: `calc(${widthPct}% - ${gap}px)`,
        background: bg,
        borderColor: border,
      }}
    >
      {/* Accent stripe */}
      <div className="absolute left-0 top-0 h-full w-1" style={{ background: accent }} />

      {/* Hover-only remove button (small) */}
      <button
        className={clsx(
          "absolute right-1.5 top-1.5 z-10",
          "opacity-0 group-hover:opacity-100 transition-opacity",
          "rounded-md bg-black/30 hover:bg-black/45",
          "p-[3px] border border-white/10"
        )}
        onClick={(ev) => {
          ev.stopPropagation();
          onDeselect(e.id);
        }}
        title="Remove"
        aria-label="Remove"
      >
        <X className="h-3 w-3" />
      </button>

      <div className="min-w-0 pl-2 pr-6">
        <div className="truncate text-[12px] font-semibold leading-4">{e.courseCode}</div>
        <div className="truncate text-[11px] font-medium text-white/80">{e.classCode}</div>

        {!isTiny && (
          <>
            <div className="mt-1 truncate text-[11px] text-white/75 tabular-nums font-mono">
              {formatMinutes(e.startMin)}–{formatMinutes(e.endMin)}
            </div>
            <div className="mt-1 truncate text-[11px] text-white/65">{e.location}</div>
          </>
        )}
      </div>
    </div>
  );
}
