import { useMemo, useRef } from "react";
import { toPng } from "html-to-image";
import { X, Upload } from "lucide-react";
import clsx from "clsx";
import { daysInData, layoutEventsByDay } from "../lib/layout";
import { formatMinutes } from "../lib/time";
import { courseToColor, hexToRgba } from "../lib/colors";
import type { ClassEvent, PositionedEvent } from "../lib/types";

type Props = {
  events: ClassEvent[];
  selected: Set<string>;
  hidden: Set<string>;
  hoveredId: string | null;
  onHoverChange: (id: string | null) => void;
  onDeselect: (id: string) => void;
};

const PX_PER_MIN = 1.2; // 72px per hour
const GRID_PAD_TOP = 10;    // px
const GRID_PAD_BOTTOM = 10; // px


export function Timetable({
  events,
  selected,
  hidden,
  hoveredId,
  onHoverChange,
  onDeselect,
}: Props) {
  const visibleSelected = useMemo(() => {
    if (hidden.size === 0) return selected;
    const next = new Set<string>();
    for (const id of selected) if (!hidden.has(id)) next.add(id);
    return next;
  }, [selected, hidden]);

  const selectedEvents = useMemo(
    () => events.filter((e) => visibleSelected.has(e.id)),
    [events, visibleSelected]
  );

  const hoveredEvent = useMemo(
    () => (hoveredId ? events.find((e) => e.id === hoveredId) ?? null : null),
    [events, hoveredId]
  );

  const previewId =
    hoveredEvent && !visibleSelected.has(hoveredEvent.id) ? hoveredEvent.id : null;

  const eventsForLayout = useMemo(() => {
    if (!hoveredEvent) return selectedEvents;
    if (selectedEvents.some((e) => e.id === hoveredEvent.id)) return selectedEvents;
    return [...selectedEvents, hoveredEvent];
  }, [selectedEvents, hoveredEvent]);

  const captureRef = useRef<HTMLDivElement | null>(null);

    async function exportPng() {
    if (!captureRef.current) return;
    const dataUrl = await toPng(captureRef.current, {
        pixelRatio: 2,
        backgroundColor: "#2b0a3d",
    });

    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "timetable.png";
    a.click();
    }


  const days = daysInData(events);
  const byDay = layoutEventsByDay(eventsForLayout);

  const start = 8 * 60;
  const end = 20 * 60;
  
  const heightPx = Math.max(1, (end - start) * PX_PER_MIN + GRID_PAD_TOP + GRID_PAD_BOTTOM);

  const hours: number[] = [];
  for (let t = start; t <= end; t += 60) hours.push(t);

  return (
    <div className="flex-1 overflow-auto">
      <div className="min-w-[900px] p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-white/80">Timetable</div>

        <div className="flex items-center gap-3">
            <button
            className="selection-ring rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10"
            onClick={exportPng}
            >
            <Upload className="h-4 w-4" />
            </button>
        </div>
        </div>
        <div ref={captureRef}  className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
          <div
            className="grid border-b border-white/10"
            style={{ gridTemplateColumns: `80px repeat(${days.length}, minmax(0, 1fr))` }}
          >
            <div className="px-4 py-2 text-[11px] font-semibold text-white/45">Time</div>
            {days.map((d) => (
              <div key={d} className="px-4 py-2 text-center text-[11px] font-semibold text-white/65">
                {d}
              </div>
            ))}
          </div>

          <div
            className="grid"
            style={{ gridTemplateColumns: `80px repeat(${days.length}, minmax(0, 1fr))` }}
          >
            <div className="relative border-r border-white/10" style={{ height: heightPx }}>
            {hours.map((t) => {
                const top = GRID_PAD_TOP + (t - start) * PX_PER_MIN; // if you added padding
                return (
                <div
                    key={t}
                    className="absolute -translate-y-1/2 w-[80px] left-0 flex items-center justify-center
                            text-[16px] font-medium text-white/45 tabular-nums font-mono"
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
                hoveredId={hoveredId}
                previewId={previewId}
                onHoverChange={onHoverChange}
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
  hoveredId,
  previewId,
  onHoverChange,
}: {
  events: PositionedEvent[];
  start: number;
  heightPx: number;
  onDeselect: (id: string) => void;
  hoveredId: string | null;
  previewId: string | null;
  onHoverChange: (id: string | null) => void;
}) {
  const end = 20 * 60;

  const ticks: number[] = [];
  for (let t = start + 30; t < end; t += 30) ticks.push(t);

  return (
    <div className="relative border-r border-white/10" style={{ height: heightPx }}>
      {/* gridlines BEHIND events */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        {ticks.map((t) => {
          const isHour = t % 60 === 0;
          const top = GRID_PAD_TOP + (t - start) * PX_PER_MIN;

          return (
            <div
              key={t}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top,
                height: 1,
                backgroundColor: isHour
                  ? "rgba(255,255,255,0.4)"
                  : "rgba(255,255,255,0.03)",
              }}
            />
          );
        })}
      </div>

      {/* events ON TOP */}
      {events.map((e) => (
        <EventCard
          key={e.id}
          e={e}
          start={start}
          onDeselect={onDeselect}
          hoveredId={hoveredId}
          previewId={previewId}
          onHoverChange={onHoverChange}
        />
      ))}
    </div>
  );
}



function EventCard({
  e,
  start,
  onDeselect,
  hoveredId,
  previewId,
  onHoverChange,
}: {
  e: PositionedEvent;
  start: number;
  onDeselect: (id: string) => void;
  hoveredId: string | null;
  previewId: string | null;
  onHoverChange: (id: string | null) => void;
}) {
  const V_GAP = 8; // px (tweak: 2–6)
  
  const top = GRID_PAD_TOP + (e.startMin - start) * PX_PER_MIN + V_GAP / 2;
  const rawHeight = (e.endMin - e.startMin) * PX_PER_MIN;
  const height = Math.max(18, rawHeight - V_GAP);

  const leftPct = (e.col / e.cols) * 100;
  const widthPct = 100 / e.cols;
  const gap = 8;

  const isTiny = height < 42;
  const tooltip = `${e.courseCode} ${e.classCode}\n${formatMinutes(e.startMin)}–${formatMinutes(
    e.endMin
  )}\n${e.location}`;

  const isHovered = hoveredId === e.id;
  const isPreview = previewId === e.id;

  const accent = courseToColor(e.courseCode);
  const bg = hexToRgba(accent, isPreview ? 0.3 : 0.9);
  const border = hexToRgba(accent, isHovered ? 0.5 : 0.6);

  return (
    <div
      title={isTiny ? tooltip : undefined}
      onMouseEnter={() => onHoverChange(e.id)}
      onMouseLeave={() => onHoverChange(null)}
      className={clsx(
        "group absolute overflow-hidden rounded-2xl px-3 py-2 text-white",
        "border bg-white/5 backdrop-blur-md",
        "shadow-[0_10px_26px_rgba(0,0,0,0.30)]",
        "hover:bg-white/7",
        isHovered && !isPreview && "ring-2 ring-white/20",
        isPreview && "opacity-60"
      )}
      style={{
        top,
        height,
        left: `calc(${leftPct}% + ${gap / 2}px)`,
        width: `calc(${widthPct}% - ${gap}px)`,
        background: bg,
        borderColor: border,
        borderStyle: isPreview ? "dashed" : "solid",
      }}
    >
      <div className="absolute left-0 top-0 h-full w-1" style={{ background: accent }} />
        <button
        className={clsx(
            "absolute z-10",
            "opacity-0 group-hover:opacity-100 transition-opacity",
            "rounded-md bg-black/30 hover:bg-black/45",
            "p-[3px] border border-white/10"
        )}
        style={{ top: 2, right: 2, left: "auto" }}   // <- hard force right
        onClick={(ev) => {
            ev.stopPropagation();
            if (!isPreview) onDeselect(e.id);
        }}
        disabled={isPreview}
        title="Remove"
        aria-label="Remove"
        >
        <X className="h-5 w-5" />
        </button>
      <div className="min-w-0 pl-2 pr-6">
        {/* Bold is driven by hoveredId, which now comes from BOTH sidebar and timetable hover */}
        <div
          className="truncate text-[12px] leading-4"
          style={{ fontWeight: isHovered ? 800 : 600 }}
        >
          {e.courseCode}
        </div>
        <div
          className="truncate text-[11px] text-white/80"
          style={{ fontWeight: isHovered ? 800 : 500 }}
        >
          {e.classCode}
        </div>

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
