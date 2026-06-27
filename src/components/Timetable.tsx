import { useEffect, useMemo, useRef, useState } from "react";
import { toPng } from "html-to-image";
import { X, Upload, Plus, AlertTriangle, Bell, BellOff, ArrowLeftRight } from "lucide-react";
import clsx from "clsx";
import { daysInData, layoutEventsByDay } from "../lib/layout";
import { formatMinutes } from "../lib/time";
import { courseToColor, hexToRgba } from "../lib/colors";
import {
  clashingIds,
  deriveWeeks,
  eventActiveInWeek,
  groupKeyOf,
  isCurrentWeek,
  weekRangeLabel,
} from "../lib/weeks";
import { semesterDates, type SemesterSel } from "../lib/semester";
import type { ClassEvent, PlanMode, PositionedEvent } from "../lib/types";
import JSZip from "jszip";

const ICS_TZID = "Australia/Brisbane";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function safeFilename(s: string) {
  return s.replace(/[^a-z0-9._-]+/gi, "_");
}

function escapeIcsText(s: string) {
  // iCal requires escaping backslashes, commas, semicolons, and newlines
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function ymdToDateLocal(ymd: string) {
  // Local date (no timezone parsing surprises)
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

function dayToOffset(d: string) {
  // Must match your days labels (MON/TUE/...)
  switch (d) {
    case "MON": return 0;
    case "TUE": return 1;
    case "WED": return 2;
    case "THU": return 3;
    case "FRI": return 4;
    case "SAT": return 5;
    case "SUN": return 6;
    default: return 0;
  }
}

function dateWithMinutes(base: Date, minutes: number) {
  const dt = new Date(base);
  dt.setHours(0, 0, 0, 0);
  dt.setMinutes(minutes);
  return dt;
}

function icsLocalDateTime(dt: Date) {
  // YYYYMMDDTHHMMSS (local time)
  const y = dt.getFullYear();
  const m = pad2(dt.getMonth() + 1);
  const d = pad2(dt.getDate());
  const hh = pad2(dt.getHours());
  const mm = pad2(dt.getMinutes());
  const ss = pad2(dt.getSeconds());
  return `${y}${m}${d}T${hh}${mm}${ss}`;
}

function downloadTextFile(filename: string, text: string, mime = "text/calendar;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Weekly occurrences across the semester for events with no real dates (CSV imports).
function fallbackWeeklyDates(e: ClassEvent, semester: SemesterSel): string[] {
  const { firstMonday, endISO } = semesterDates(semester);
  const cur = ymdToDateLocal(firstMonday);
  cur.setDate(cur.getDate() + dayToOffset(e.day));
  const end = ymdToDateLocal(endISO);
  const out: string[] = [];
  while (cur <= end) {
    out.push(`${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}`);
    cur.setDate(cur.getDate() + 7);
  }
  return out;
}

function buildIcsForEvents(events: ClassEvent[], semester: SemesterSel) {
  const dtstamp = icsLocalDateTime(new Date());

  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//UQ Timetable Planner//EN");
  lines.push("CALSCALE:GREGORIAN");

  for (const e of events) {
    // Scraped classes carry their real dates; CSV imports fall back to weekly across the semester.
    const dates =
      e.activeDates && e.activeDates.length ? [...e.activeDates].sort() : fallbackWeeklyDates(e, semester);
    if (dates.length === 0) continue;

    const startDt = dateWithMinutes(ymdToDateLocal(dates[0]), e.startMin);
    const endDt = dateWithMinutes(ymdToDateLocal(dates[0]), e.endMin);

    // Stable UID so re-imports update the same series (less duplication).
    const uid = `${e.id}@uqtimetable`;
    const summary = e.title
      ? `${e.courseCode} ${e.classCode} — ${e.title}`
      : `${e.courseCode} ${e.classCode}`;
    const description =
      `${e.courseCode} ${e.classCode}\n` +
      `${formatMinutes(e.startMin)}–${formatMinutes(e.endMin)}\n` +
      `${e.location}`;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcsText(uid)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${escapeIcsText(summary)}`);
    lines.push(`LOCATION:${escapeIcsText(e.location)}`);
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
    lines.push(`DTSTART;TZID=${ICS_TZID}:${icsLocalDateTime(startDt)}`);
    lines.push(`DTEND;TZID=${ICS_TZID}:${icsLocalDateTime(endDt)}`);

    // Exact occurrences — DTSTART is the first, RDATE adds the rest. Handles mid-sem breaks.
    if (dates.length > 1) {
      const rdates = dates
        .slice(1)
        .map((iso) => icsLocalDateTime(dateWithMinutes(ymdToDateLocal(iso), e.startMin)));
      lines.push(`RDATE;TZID=${ICS_TZID}:${rdates.join(",")}`);
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // iCal expects CRLF line endings
  return lines.join("\r\n") + "\r\n";
}


type Props = {
  events: ClassEvent[];
  selected: Set<string>;
  hidden: Set<string>;
  hoveredId: string | null;
  onHoverChange: (id: string | null) => void;
  onDeselect: (id: string) => void;
  semester: SemesterSel;
  mode: PlanMode;
  ignoreClashes: boolean;
  clashIgnored: Set<string>;
  onToggleClashIgnore: (id: string) => void;

  previewGroupKey: string | null;
  onPreviewGroupKeyChange: (key: string | null) => void;
};

const PX_PER_MIN = 1.2; // 72px per hour
const GRID_PAD_TOP = 10; // px
const GRID_PAD_BOTTOM = 10; // px

export function Timetable({
  events,
  selected,
  hidden,
  hoveredId,
  onHoverChange,
  onDeselect,
  semester,
  mode,
  ignoreClashes,
  clashIgnored,
  onToggleClashIgnore,
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

  // Raw overlaps (no ignores) + the effective set after the global and per-class ignores.
  const rawClashing = useMemo(() => clashingIds(selectedEvents), [selectedEvents]);
  const clashing = useMemo(
    () => (ignoreClashes ? new Set<string>() : clashingIds(selectedEvents, clashIgnored)),
    [selectedEvents, ignoreClashes, clashIgnored]
  );
  // Cards shown with the "ignored" treatment: actually overlapping, per-class-ignored, warnings on.
  const clashIgnoredVisible = useMemo(() => {
    if (ignoreClashes) return new Set<string>();
    const s = new Set<string>();
    for (const id of clashIgnored) if (rawClashing.has(id)) s.add(id);
    return s;
  }, [clashIgnored, rawClashing, ignoreClashes]);

  // Week selector (view-only filter), derived from the selected classes' real dates.
  const weeks = useMemo(() => deriveWeeks(selectedEvents), [selectedEvents]);
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const activeWeek =
    selectedWeek && weeks.some((w) => w.weekStartISO === selectedWeek) ? selectedWeek : null;

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
      return groupKeyOf(e) === previewGroupKey;
    });
  }, [events, previewGroupKey, hidden, visibleSelected]);

  const eventsForLayout = useMemo(() => {
    const base = [...selectedEvents, ...previewGroupEvents];

    if (!hoveredEvent) return base;

    if (base.some((e) => e.id === hoveredEvent.id)) return base;
    if (hidden.has(hoveredEvent.id)) return base;

    return [...base, hoveredEvent];
  }, [selectedEvents, previewGroupEvents, hoveredEvent, hidden]);

  // Apply the week filter (if a specific week is chosen) to what gets laid out.
  const layoutEvents = useMemo(
    () => (activeWeek ? eventsForLayout.filter((e) => eventActiveInWeek(e, activeWeek)) : eventsForLayout),
    [eventsForLayout, activeWeek]
  );

  const captureRef = useRef<HTMLDivElement | null>(null);

  function exportIcal() {
    // Export only the selected (and not hidden) events.
    const ics = buildIcsForEvents(selectedEvents, semester);
    downloadTextFile("timetable.ics", ics);
  }

  async function exportIcalZipPerCourse() {
    // group selected events by course
    const byCourse = new Map<string, ClassEvent[]>();
    for (const e of selectedEvents) {
      const key = e.courseCode;
      const arr = byCourse.get(key) ?? [];
      arr.push(e);
      byCourse.set(key, arr);
    }

    // build zip
    const zip = new JSZip();
    const folder = zip.folder("iCal_by_course")!;

    for (const [courseCode, evs] of byCourse) {
      const ics = buildIcsForEvents(evs, semester);

      // .ics files are just UTF-8 text
      folder.file(`${safeFilename(courseCode)}.ics`, ics);
    }

    const blob = await zip.generateAsync({ type: "blob" });

    // download blob
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `timetables_${semester.code}_${semester.year}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
  const byDay = layoutEventsByDay(layoutEvents);

  const start = 8 * 60;
  const end = 20 * 60;

  const heightPx = Math.max(1, (end - start) * PX_PER_MIN + GRID_PAD_TOP + GRID_PAD_BOTTOM);

  const hours: number[] = [];
  for (let t = start; t <= end; t += 60) hours.push(t);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
      <div className="min-w-[900px] p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-white/80">Timetable</div>
            {clashing.size > 0 ? (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-200"
                title="Selected classes that overlap"
              >
                <AlertTriangle className="h-3 w-3" />
                {clashing.size} clashing
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <button
              className="selection-ring rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10"
              onClick={exportIcalZipPerCourse}
              title="Export one .ics per course (zipped)"
            >
              iCal (per course)
            </button>

            <button
              className="selection-ring rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10"
              onClick={exportIcal}
              title="Export iCal"
            >
              iCal
            </button>

            <button
              className="selection-ring rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10"
              onClick={exportPng}
              title="Export PNG"
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
                clashingIds={clashing}
                clashIgnoredIds={clashIgnoredVisible}
                onToggleClashIgnore={onToggleClashIgnore}
                mode={mode}
              />
            ))}
          </div>
        </div>

      </div>
      </div>

      {/* Week selector — sticky footer; filters the view to a single teaching week */}
      {weeks.length > 0 ? (
        <div className="shrink-0 border-t border-white/10 bg-[#0b0f14]/70 px-5 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/40">
              Week
            </span>

            <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setSelectedWeek(null)}
                className={clsx(
                  "shrink-0 rounded-full text-[12px] font-medium",
                  activeWeek === null ? "ctl-on" : "ctl-seg"
                )}
                style={{ padding: "5px 14px" }}
              >
                All
              </button>
              {weeks.map((w) => {
                const isActive = activeWeek === w.weekStartISO;
                const current = isCurrentWeek(w.weekStartISO);
                return (
                  <button
                    key={w.weekStartISO}
                    type="button"
                    onClick={() => setSelectedWeek(w.weekStartISO)}
                    title={`Week ${w.index} · ${weekRangeLabel(w.weekStartISO)}`}
                    className={clsx(
                      "shrink-0 rounded-full text-center text-[12px] font-medium tabular-nums",
                      isActive ? "ctl-on" : "ctl-seg"
                    )}
                    style={{
                      minWidth: 32,
                      padding: "5px 8px",
                      ...(current && !isActive ? { color: "#7dd3fc" } : {}),
                    }}
                  >
                    {w.index}
                  </button>
                );
              })}
            </div>

            <span className="ml-auto shrink-0 text-[12px] tabular-nums text-white/45">
              {activeWeek ? weekRangeLabel(activeWeek) : "All weeks"}
            </span>
          </div>
        </div>
      ) : null}
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
  clashingIds,
  clashIgnoredIds,
  onToggleClashIgnore,
  mode,
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
  clashingIds: Set<string>;
  clashIgnoredIds: Set<string>;
  onToggleClashIgnore: (id: string) => void;
  mode: PlanMode;
}) {
  const end = 20 * 60;

  const bandHeight = 30 * PX_PER_MIN; // half hour
  const totalMinutes = end - start;
  const bandCount = Math.ceil(totalMinutes / 30);

  const INSET_X = 2; // how much the stripes are inset horizontally

  return (
    <div className="relative border-r border-white/10" style={{ height: heightPx }}>
      {/* ---- STRIPY HALF-HOUR BACKGROUND ---- */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        {Array.from({ length: bandCount }).map((_, i) => {
          const top = GRID_PAD_TOP + i * bandHeight;

          const isEven = i % 2 === 0;

          const background = isEven
            ? "rgba(255,255,255,0.025)"
            : "rgba(0,0,0,0.06)";

          const isHourStart = i % 2 === 0;

          return (
            <div
              key={`band-${i}`}
              style={{
                position: "absolute",
                left: INSET_X,
                right: INSET_X,
                top,
                height: bandHeight,
                background,
                borderTop: isHourStart
                  ? "1px solid rgba(255,255,255,0.08)"
                  : "none",
                borderRadius: 8,
              }}
            />
          );
        })}
      </div>

      {/* ---- EVENTS ON TOP ---- */}
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
          isClashing={clashingIds.has(e.id)}
          isClashIgnored={clashIgnoredIds.has(e.id)}
          onToggleClashIgnore={onToggleClashIgnore}
          mode={mode}
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
  isClashing,
  isClashIgnored,
  onToggleClashIgnore,
  mode,
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
  isClashing: boolean;
  isClashIgnored: boolean;
  onToggleClashIgnore: (id: string) => void;
  mode: PlanMode;
}) {
  const V_GAP = 8;

  const top = GRID_PAD_TOP + (e.startMin - start) * PX_PER_MIN + V_GAP / 2;
  const rawHeight = (e.endMin - e.startMin) * PX_PER_MIN;
  const height = Math.max(18, rawHeight - V_GAP);

  const leftPct = (e.col / e.cols) * 100;
  const widthPct = 100 / e.cols;
  const gap = 13;
  const CARD_NUDGE_X = -1.5; // px (negative moves left)

  const isTiny = height < 42;
  const tooltip = `${e.courseCode} ${e.classCode}\n${formatMinutes(e.startMin)}–${formatMinutes(
    e.endMin
  )}\n${e.location}`;

  const isHovered = hoveredId === e.id;

  const groupKey = groupKeyOf(e);
  const isGroupActive = previewGroupKey === groupKey;

  const isHoverPreview = previewId === e.id;
  const isGroupPreview = isGroupActive && !isEnabled;
  const isGroupHighlight = isGroupActive && isEnabled;

  const accent = courseToColor(e.courseCode);

  const bgAlpha = isGroupPreview ? 0.40 : isHoverPreview ? 0.80 : 0.75;
  const bg = hexToRgba(accent, bgAlpha);
  const border = hexToRgba(accent, isHovered || isGroupHighlight ? 0.2 : 0.8);

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

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
        "group absolute overflow-hidden rounded-[10px] px-3 py-2 text-white",
        "[transition-property:top,left,width,height,transform,opacity]",
        "[transition-duration:350ms,350ms,350ms,350ms,350ms,250ms]",
        "[transition-delay:0ms,0ms,0ms,0ms,0ms,150ms]",
        "[transition-timing-function:cubic-bezier(0.4,0,0.2,1)]",
        "will-change-[opacity,transform,top,left,width,height]",
        "hover:brightness-[1.03]",
        !mounted && "opacity-0 translate-y-1",
        mounted && "opacity-100 translate-y-0",
        (isHovered || isGroupHighlight) && "ring-1",
        (isHoverPreview || isGroupPreview) && "opacity-50"
      )}
      style={{
        top,
        height,
        left: `calc(${leftPct}% + ${gap / 2 + CARD_NUDGE_X}px)`,
        width: `calc(${widthPct}% - ${gap}px)`,
        backgroundColor: bg,
        borderColor: border,
        borderStyle: isHoverPreview || isGroupPreview ? "dashed" : "solid",
        boxShadow: isClashing
          ? "0 0 0 2px rgba(248,113,113,0.95)"
          : isClashIgnored
          ? "0 0 0 2px rgba(251,191,36,0.85)"
          : undefined,
        cursor: "pointer",
      }}
    >

      <button
        className={clsx(
          "absolute z-10",
          "opacity-0 group-hover:opacity-100 transition-opacity",
          "rounded-[10px] border border-white/15 bg-white/10 backdrop-blur-xl",
          "shadow-[0_8px_18px_rgba(0,0,0,0.25)]",
          "hover:bg-white/15 active:bg-white/20",
          "p-[2px]"
        )}
        style={{ top: 2, right: 2, left: "auto" }}
        onClick={(ev) => {
          ev.stopPropagation();
          onDeselect(e.id);
        }}
        title={isEnabled ? "Remove" : mode === "student" ? "Swap" : "Add"}
        aria-label={isEnabled ? "Remove" : mode === "student" ? "Swap" : "Add"}
      >
        {isEnabled ? (
          <X className="h-[14px] w-[17px] translate-y-[1.5px]" strokeWidth={1.8} />
        ) : mode === "student" ? (
          <ArrowLeftRight className="h-[14px] w-[17px] translate-y-[1.5px]" strokeWidth={1.8} />
        ) : (
          <Plus className="h-[14px] w-[17px] translate-y-[1.5px]" strokeWidth={1.8} />
        )}
      </button>

      {isClashing || isClashIgnored ? (
        <button
          className="absolute z-10 rounded-[8px] border border-white/15 bg-white/10 p-[2px] shadow-[0_8px_18px_rgba(0,0,0,0.25)] backdrop-blur-xl hover:bg-white/15 active:bg-white/20"
          style={{ top: 2, left: 2 }}
          onClick={(ev) => {
            ev.stopPropagation();
            onToggleClashIgnore(e.id);
          }}
          title={isClashIgnored ? "Clashes ignored — click to restore the warning" : "Ignore clashes for this class"}
          aria-label={isClashIgnored ? "Restore clash warning" : "Ignore clashes for this class"}
        >
          {isClashIgnored ? (
            <BellOff className="h-[14px] w-[14px]" strokeWidth={1.8} style={{ color: "#fbbf24" }} />
          ) : (
            <Bell className="h-[14px] w-[14px]" strokeWidth={1.8} style={{ color: "#fca5a5" }} />
          )}
        </button>
      ) : null}

      <div
        className="min-w-0 pr-6 relative"
        style={{ paddingLeft: isClashing || isClashIgnored ? 26 : 8 }}
      >
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
            {e.building ? (
              <div className="truncate text-[10px] leading-tight text-white/45">{e.building}</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
