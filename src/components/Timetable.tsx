import { useMemo, useRef } from "react";
import { toPng } from "html-to-image";
import { X, Upload, Plus } from "lucide-react";
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

  previewGroupKey: string | null;
  onPreviewGroupKeyChange: (key: string | null) => void;
};

const PX_PER_MIN = 1.2; // 72px per hour
const GRID_PAD_TOP = 10; // px
const GRID_PAD_BOTTOM = 10; // px

function classTypeFromClassCode(classCode: string) {
  return classCode.split("-")[0] ?? classCode;
}

function makeGroupKey(e: ClassEvent) {
  return `${e.courseCode}::${classTypeFromClassCode(e.classCode)}`;
}

export function Timetable({
  events,
  selected,
  hidden,
  hoveredId,
  onHoverChange,
  onDeselect,
  previewGroupKey,
  onPreviewGroupKeyChange,
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

  // hover-preview (sidebar hover over non-selected)
  const previewId =
    hoveredEvent && !visibleSelected.has(hoveredEvent.id) ? hoveredEvent.id : null;

  // group preview events (courseCode + PRA1/APP1 etc)
  // - respect hidden
  // - don't add already-selected-visible ones (they get highlighted instead)
  const previewGroupEvents = useMemo(() => {
    if (!previewGroupKey) return [];
    return events.filter((e) => {
      if (hidden.has(e.id)) return false;
      if (visibleSelected.has(e.id)) return false;
      return makeGroupKey(e) === previewGroupKey;
    });
  }, [events, previewGroupKey, hidden, visibleSelected]);

  const eventsForLayout = useMemo(() => {
    const base = [...selectedEvents, ...previewGroupEvents];

    if (!hoveredEvent) return base;

    if (base.some((e) => e.id === hoveredEvent.id)) return base;
    if (hidden.has(hoveredEvent.id)) return base;

    return [...base, hoveredEvent];
  }, [selectedEvents, previewGroupEvents, hoveredEvent, hidden]);

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

        <div
          ref={captureRef}
          className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_18px_60px_rgba(0,0,0,0.35)]"
          onClick={(ev) => {
            const target = ev.target as HTMLElement | null;
            if (!target) return;
            if (target.closest("[data-event-card='1']")) return;
            onPreviewGroupKeyChange(null);
          }}
        >
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
                const top = GRID_PAD_TOP + (t - start) * PX_PER_MIN;
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
                previewGroupKey={previewGroupKey}
                onPreviewGroupKeyChange={onPreviewGroupKeyChange}
                enabledIds={visibleSelected}
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
  previewGroupKey,
  onPreviewGroupKeyChange,
  enabledIds,
}: {
  events: PositionedEvent[];
  start: number;
  heightPx: number;
  onDeselect: (id: string) => void;
  hoveredId: string | null;
  previewId: string | null;
  onHoverChange: (id: string | null) => void;

  previewGroupKey: string | null;
  onPreviewGroupKeyChange: (key: string | null) => void;

  enabledIds: Set<string>;
}) {
  const end = 20 * 60;

  const ticks: number[] = [];
  for (let t = start + 30; t < end; t += 30) ticks.push(t);

  return (
    <div className="relative border-r border-white/10" style={{ height: heightPx }}>
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
                backgroundColor: isHour ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.03)",
              }}
            />
          );
        })}
      </div>

      {events.map((e) => (
        <EventCard
          key={e.id}
          e={e}
          start={start}
          onDeselect={onDeselect}
          hoveredId={hoveredId}
          previewId={previewId}
          onHoverChange={onHoverChange}
          previewGroupKey={previewGroupKey}
          onPreviewGroupKeyChange={onPreviewGroupKeyChange}
          isEnabled={enabledIds.has(e.id)}
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
  previewGroupKey,
  onPreviewGroupKeyChange,
  isEnabled,
}: {
  e: PositionedEvent;
  start: number;
  onDeselect: (id: string) => void;
  hoveredId: string | null;
  previewId: string | null;
  onHoverChange: (id: string | null) => void;

  previewGroupKey: string | null;
  onPreviewGroupKeyChange: (key: string | null) => void;

  isEnabled: boolean;
}) {
  const V_GAP = 8;

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

  const groupKey = `${e.courseCode}::${classTypeFromClassCode(e.classCode)}`;
  const isGroupActive = previewGroupKey === groupKey;

  // Two kinds of preview:
  // 1) hover-preview (previewId)
  // 2) group-preview (active group + NOT enabled)
  const isHoverPreview = previewId === e.id;
  const isGroupPreview = isGroupActive && !isEnabled;

  // For selected/enabled cards in an active group, highlight like hover
  const isGroupHighlight = isGroupActive && isEnabled;

  const accent = courseToColor(e.courseCode);

  // Make preview cards slightly more transparent:
  // - hover preview: 0.22
  // - group preview: 0.18 (a bit more transparent than hover preview)
  const bgAlpha = isGroupPreview ? 0.18 : isHoverPreview ? 0.22 : 0.9;
  const bg = hexToRgba(accent, bgAlpha);

  const border = hexToRgba(accent, isHovered || isGroupHighlight ? 0.5 : 0.6);

  return (
    <div
      data-event-card="1"
      title={isTiny ? tooltip : undefined}
      onMouseEnter={() => onHoverChange(e.id)}
      onMouseLeave={() => onHoverChange(null)}
      onClick={() => {
        onPreviewGroupKeyChange(isGroupActive ? null : groupKey);
      }}
      className={clsx(
        "group absolute overflow-hidden rounded-2xl px-3 py-2 text-white",
        "border bg-white/5 backdrop-blur-md",
        "shadow-[0_10px_26px_rgba(0,0,0,0.30)]",
        "hover:bg-white/7",
        (isHovered || isGroupHighlight) && "ring-2 ring-white/20",
        (isHoverPreview || isGroupPreview) && "opacity-75"
      )}
      style={{
        top,
        height,
        left: `calc(${leftPct}% + ${gap / 2}px)`,
        width: `calc(${widthPct}% - ${gap}px)`,
        background: bg,
        borderColor: border,
        borderStyle: isHoverPreview || isGroupPreview ? "dashed" : "solid",
        cursor: "pointer",
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
        style={{ top: 2, right: 2, left: "auto" }}
        onClick={(ev) => {
          ev.stopPropagation();

          // If not enabled, this acts as "+" (add)
          // If enabled, this acts as "X" (remove)
          onDeselect(e.id);
        }}
        title={!isEnabled ? "Add" : "Remove"}
        aria-label={!isEnabled ? "Add" : "Remove"}
      >
        {!isEnabled ? <Plus className="h-5 w-5" /> : <X className="h-5 w-5" />}
      </button>

      <div className="min-w-0 pl-2 pr-6">
        <div
          className="truncate text-[12px] leading-4"
          style={{ fontWeight: isHovered || isGroupHighlight ? 800 : 600 }}
        >
          {e.courseCode}
        </div>
        <div
          className="truncate text-[11px] text-white/80"
          style={{ fontWeight: isHovered || isGroupHighlight ? 800 : 500 }}
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
