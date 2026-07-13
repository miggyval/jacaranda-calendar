import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { toPng, toBlob } from "html-to-image";
import { X, Upload, Plus, AlertTriangle, Bell, BellOff, ArrowLeftRight, ClipboardCopy, FileSpreadsheet } from "lucide-react";
import clsx from "clsx";
import Papa from "papaparse";
import { daysInData, layoutEventsByDay } from "../lib/layout";
import { formatMinutes } from "../lib/time";
import { courseToColor, hexToRgba } from "../lib/colors";
import { downloadTextFile, downloadBlob } from "../lib/download";
import {
  clashingIds,
  deriveWeeks,
  eventActiveInWeek,
  groupKeyOf,
  isCurrentWeek,
  weekRangeLabel,
} from "../lib/weeks";
import { semesterDates, type SemesterSel } from "../lib/semester";
import type { ClassEvent, Day, PlanMode, PositionedEvent } from "../lib/types";
import JSZip from "jszip";

const ICS_TZID = "Australia/Brisbane";

// Ignore a few px of overflow so cards that essentially fit don't do a pointless crawl on hover.
const OVERFLOW_TOL = 6;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function safeFilename(s: string) {
  return s.replace(/[^a-z0-9._-]+/gi, "_");
}

// Room + building on one line, e.g. "50-S201 Hawken Engineering Building".
function fullLocation(e: { location: string; building?: string }): string {
  return e.building ? `${e.location} ${e.building}` : e.location;
}

function escapeIcsText(s: string) {
  // iCal requires escaping backslashes, commas, semicolons, and newlines
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// RFC 5545 content lines must be folded at 75 octets (continuation = CRLF + one space).
function foldIcsLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    // First physical line holds 75 octets; continuations reserve 1 for the leading space.
    const limit = out.length === 0 ? 75 : 74;
    if (curBytes + chBytes > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += chBytes;
  }
  out.push(cur);
  return out.join("\r\n ");
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

function buildIcsForEvents(
  events: ClassEvent[],
  semester: SemesterSel,
  opts?: { calName?: string; color?: string; mode?: PlanMode }
) {
  const dtstamp = icsLocalDateTime(new Date());
  const calName = opts?.calName ?? `Jacaranda Calendar — ${semester.code} ${semester.year}`;

  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//Jacaranda Calendar//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push(`X-WR-CALNAME:${escapeIcsText(calName)}`);
  lines.push(`NAME:${escapeIcsText(calName)}`);
  lines.push(`X-WR-TIMEZONE:${ICS_TZID}`);
  if (opts?.color) {
    // Apple reads the hex here; distinct colour per course when exported one file each.
    lines.push(`X-APPLE-CALENDAR-COLOR:${opts.color}`);
  }

  // Brisbane observes no DST, so a single STANDARD offset fully defines the zone.
  lines.push("BEGIN:VTIMEZONE");
  lines.push(`TZID:${ICS_TZID}`);
  lines.push("BEGIN:STANDARD");
  lines.push("DTSTART:19700101T000000");
  lines.push("TZOFFSETFROM:+1000");
  lines.push("TZOFFSETTO:+1000");
  lines.push("TZNAME:AEST");
  lines.push("END:STANDARD");
  lines.push("END:VTIMEZONE");

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
    const loc = fullLocation(e);
    const descParts = [
      e.title ? `${e.courseCode}: ${e.title}` : e.courseCode,
      e.classCode,
      `${formatMinutes(e.startMin)}–${formatMinutes(e.endMin)}`,
      loc,
    ];
    // Staff plans care about who's teaching; student plans care about remaining seats.
    if (opts?.mode === "staff") {
      if (e.staff) descParts.push(`Staff: ${e.staff}`);
    } else if (typeof e.availability === "number") {
      descParts.push(`Seats left: ${e.availability}`);
    }
    const description = descParts.join("\n");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcsText(uid)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push("SEQUENCE:0");
    lines.push(`SUMMARY:${escapeIcsText(summary)}`);
    lines.push(`LOCATION:${escapeIcsText(loc)}`);
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

    // A 10-minute pop reminder before each class.
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${escapeIcsText(summary)}`);
    lines.push("TRIGGER:-PT10M");
    lines.push("END:VALARM");

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // iCal expects CRLF line endings, with long lines folded at 75 octets.
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
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

  locked: boolean;
  onEditEvent: (e: ClassEvent) => void;
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
  locked,
  onEditEvent,
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
  // While true, the capture region also renders a title/legend header (for PNG export).
  const [exporting, setExporting] = useState(false);

  const semLabel = `${semester.code} ${semester.year}`;

  function exportIcal() {
    // Export only the selected (and not hidden) events.
    const ics = buildIcsForEvents(selectedEvents, semester, { mode });
    downloadTextFile(`timetable_${semester.code}_${semester.year}.ics`, ics);
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
      const title = evs.find((e) => e.title)?.title;
      // Per-course calendar name + colour so each imports as a distinct, coloured calendar.
      const ics = buildIcsForEvents(evs, semester, {
        calName: title ? `${courseCode} — ${title}` : courseCode,
        color: courseToColor(courseCode),
        mode,
      });

      // .ics files are just UTF-8 text
      folder.file(`${safeFilename(courseCode)}.ics`, ics);
    }

    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(`timetables_${semester.code}_${semester.year}.zip`, blob);
  }

  function exportCsv() {
    // Round-trips with parseClassesCsv: all classes, Enabled=1 for the currently selected ones.
    const rows = events.map((e) => ({
      CourseCode: e.courseCode,
      ClassCode: e.classCode,
      Day: e.day,
      StartTime: formatMinutes(e.startMin),
      EndTime: formatMinutes(e.endMin),
      Location: e.location,
      Enabled: selected.has(e.id) ? 1 : 0,
    }));
    const csv = Papa.unparse(rows, {
      columns: ["CourseCode", "ClassCode", "Day", "StartTime", "EndTime", "Location", "Enabled"],
    });
    downloadTextFile(`timetable_${semester.code}_${semester.year}.csv`, csv, "text/csv;charset=utf-8");
  }

  // Render the export header, wait two frames for layout, then run the capture.
  async function withExportHeader<T>(capture: () => Promise<T>): Promise<T | undefined> {
    if (!captureRef.current) return undefined;
    setExporting(true);
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return await capture();
    } finally {
      setExporting(false);
    }
  }

  async function exportPng() {
    const pngName = `timetable_${semester.code}_${semester.year}${activeWeek ? `_wk${activeWeek}` : ""}.png`;
    await withExportHeader(async () => {
      const dataUrl = await toPng(captureRef.current!, { pixelRatio: 2, backgroundColor: "#2b0a3d" });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = pngName;
      a.click();
    });
  }

  async function copyPng() {
    await withExportHeader(async () => {
      const blob = await toBlob(captureRef.current!, { pixelRatio: 2, backgroundColor: "#2b0a3d" });
      if (!blob) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      } catch {
        // Some webviews block writing images to the clipboard — fall back to a download.
        downloadBlob(`timetable_${semester.code}_${semester.year}.png`, blob);
      }
    });
  }

  const days = daysInData(events);
  const byDay = layoutEventsByDay(layoutEvents);

  // Auto-fit the visible window to the selected classes/events (+ padding to the hour),
  // clamped to a sane range with a minimum span; falls back to 08:00–20:00 when empty.
  const { start, end } = useMemo(() => {
    if (selectedEvents.length === 0) return { start: 8 * 60, end: 20 * 60 };
    let min = Infinity;
    let max = -Infinity;
    for (const e of selectedEvents) {
      if (e.startMin < min) min = e.startMin;
      if (e.endMin > max) max = e.endMin;
    }
    const s = Math.max(6 * 60, Math.floor(min / 60) * 60);
    let en = Math.min(22 * 60, Math.ceil(max / 60) * 60);
    if (en - s < 8 * 60) en = Math.min(22 * 60, s + 8 * 60);
    return { start: s, end: en };
  }, [selectedEvents]);

  const heightPx = Math.max(1, (end - start) * PX_PER_MIN + GRID_PAD_TOP + GRID_PAD_BOTTOM);

  const hours: number[] = [];
  for (let t = start; t <= end; t += 60) hours.push(t);

  // "Now" line + today highlight (shown when the current week — or "all weeks" — is in view).
  const nowDate = new Date();
  const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();
  const DAY_NAMES: Day[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const todayDay = DAY_NAMES[nowDate.getDay()];
  const currentWeekISO = weeks.find((w) => isCurrentWeek(w.weekStartISO))?.weekStartISO ?? null;
  const showToday = activeWeek === null || activeWeek === currentWeekISO;
  const nowLineMin = showToday && nowMin >= start && nowMin <= end ? nowMin : null;

  // Title/caption/legend shown in the exported image (only while `exporting`).
  const activeWeekOpt = activeWeek ? weeks.find((w) => w.weekStartISO === activeWeek) : null;
  const pngCaption = activeWeekOpt
    ? `Week ${activeWeekOpt.index} · ${weekRangeLabel(activeWeek!)}`
    : "All weeks";
  const legendCourses = Array.from(new Set(selectedEvents.map((e) => e.courseCode)));

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
              className="selection-ring inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10"
              onClick={exportCsv}
              title="Export CSV (re-importable)"
            >
              <FileSpreadsheet className="h-4 w-4" />
              CSV
            </button>

            <button
              className="selection-ring rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10"
              onClick={exportPng}
              title="Export PNG"
            >
              <Upload className="h-4 w-4" />
            </button>

            <button
              className="selection-ring rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10"
              onClick={copyPng}
              title="Copy timetable image to clipboard"
              aria-label="Copy timetable image to clipboard"
            >
              <ClipboardCopy className="h-4 w-4" />
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
          {exporting && (
            <div style={{ padding: "18px 22px 6px" }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#ffffff", letterSpacing: "-0.01em" }}>
                Jacaranda Calendar — {semLabel}
              </div>
              <div style={{ marginTop: 2, fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{pngCaption}</div>
              {legendCourses.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12 }}>
                  {legendCourses.map((c) => (
                    <div key={c} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{ width: 12, height: 12, borderRadius: 3, background: courseToColor(c), display: "inline-block" }}
                      />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.82)" }}>{c}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div
            className="grid border-b border-white/10"
            style={{ gridTemplateColumns: `80px repeat(${days.length}, minmax(0, 1fr))` }}
          >
            <div className="px-4 py-2 text-[11px] font-semibold text-white/45">Time</div>
            {days.map((d) => (
              <div
                key={d}
                className="px-4 py-2 text-center text-[11px] font-semibold"
                style={{ color: showToday && d === todayDay ? "#7dd3fc" : "rgba(255,255,255,0.65)" }}
              >
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
                end={end}
                heightPx={heightPx}
                isToday={showToday && d === todayDay}
                nowLineMin={nowLineMin}
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
                locked={locked}
                onEditEvent={onEditEvent}
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
              <button
                type="button"
                onClick={() => currentWeekISO && setSelectedWeek(currentWeekISO)}
                disabled={!currentWeekISO}
                className={clsx(
                  "shrink-0 rounded-full text-[12px] font-medium disabled:opacity-30",
                  activeWeek && activeWeek === currentWeekISO ? "ctl-on" : "ctl-seg"
                )}
                style={{ padding: "5px 14px" }}
                title="Jump to the current teaching week"
              >
                Today
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
  end,
  isToday,
  nowLineMin,
  locked,
  onEditEvent,
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
  end: number;
  isToday: boolean;
  nowLineMin: number | null;
  locked: boolean;
  onEditEvent: (e: ClassEvent) => void;
}) {
  const bandHeight = 30 * PX_PER_MIN; // half hour
  const totalMinutes = end - start;
  const bandCount = Math.ceil(totalMinutes / 30);

  const INSET_X = 2; // how much the stripes are inset horizontally

  return (
    <div
      className="relative border-r border-white/10"
      style={{ height: heightPx, background: isToday ? "rgba(125,211,252,0.05)" : undefined }}
    >
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

      {/* ---- NOW LINE (today only) ---- */}
      {isToday && nowLineMin != null ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: GRID_PAD_TOP + (nowLineMin - start) * PX_PER_MIN,
            borderTop: "2px solid rgba(248,113,113,0.9)",
            zIndex: 5,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: -4,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "rgba(248,113,113,0.95)",
            }}
          />
        </div>
      ) : null}

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
          locked={locked}
          onEditEvent={onEditEvent}
        />
      ))}
    </div>
  );
}


// A single text line that, when it's too narrow to show its full text, scrolls
// horizontally to reveal the clipped tail after the card is hovered for 1.5s
// (mirrors the vertical auto-scroll on short cards). Idle, it shows an ellipsis.
function ScrollLine({
  text,
  className,
  style,
  hovered,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
  hovered: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const hoveredRef = useRef(hovered);
  hoveredRef.current = hovered;
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const measure = () => {
      // Only meaningful at text-indent 0, so skip while the line is scrolled open.
      if (!ref.current || hoveredRef.current) return;
      const o = ref.current.scrollWidth - ref.current.clientWidth;
      setOverflow(reduceMotion || o <= OVERFLOW_TOL ? 0 : o);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, style?.fontWeight]);

  const active = overflow > 0;
  return (
    <div
      ref={ref}
      className={clsx("truncate", className)}
      style={{
        ...style,
        ...(active
          ? {
              textIndent: hovered ? `-${overflow}px` : "0px",
              textOverflow: hovered ? "clip" : "ellipsis",
              transition: hovered
                ? `text-indent ${Math.max(0.8, overflow / 40)}s ease-in-out 1s`
                : "text-indent 0.25s ease",
            }
          : {}),
      }}
    >
      {text}
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
  locked,
  onEditEvent,
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
  locked: boolean;
  onEditEvent: (e: ClassEvent) => void;
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

  // When a short card can't show all its text, hovering scrolls it up to reveal the bottom.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [cardHovered, setCardHovered] = useState(false);
  const [overflowPx, setOverflowPx] = useState(0);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const available = height - 16; // card height minus py-2 (8 + 8)
    const raw = el.scrollHeight - available;
    setOverflowPx(reduceMotion || raw <= OVERFLOW_TOL ? 0 : raw);
  }, [height, isTiny, e.courseCode, e.classCode, e.location, e.building, isClashing, isClashIgnored]);

  // Student-mode drag-to-swap: drag a selected card onto an equivalent ghost slot to switch streams.
  const canDrag = mode === "student" && isEnabled && !locked && !e.custom;
  const dragRef = useRef<{ startX: number; startY: number; dragging: boolean; pointerId: number } | null>(null);
  const didDragRef = useRef(false);
  const highlightRef = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);

  function clearHighlight() {
    if (highlightRef.current) {
      highlightRef.current.style.outline = "";
      highlightRef.current.style.outlineOffset = "";
      highlightRef.current = null;
    }
  }

  // The equivalent ghost card under (x,y), or null. Hides `self` so it doesn't shadow the ghost.
  function ghostUnder(x: number, y: number, self: HTMLElement): HTMLElement | null {
    const prev = self.style.pointerEvents;
    self.style.pointerEvents = "none";
    const el = ((document.elementFromPoint(x, y) as HTMLElement | null)?.closest(
      "[data-event-card]"
    ) ?? null) as HTMLElement | null;
    self.style.pointerEvents = prev;
    if (el && el.dataset.groupKey === groupKey && el.dataset.enabled === "0" && el.dataset.eventId && el.dataset.eventId !== e.id) {
      return el;
    }
    return null;
  }

  function onCardPointerDown(ev: ReactPointerEvent<HTMLDivElement>) {
    if (!canDrag || ev.button !== 0) return;
    if ((ev.target as HTMLElement).closest("button")) return; // let the ↔ / bell buttons work
    dragRef.current = { startX: ev.clientX, startY: ev.clientY, dragging: false, pointerId: ev.pointerId };
    didDragRef.current = false;
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      // pointer capture is best-effort
    }
  }

  function onCardPointerMove(ev: ReactPointerEvent<HTMLDivElement>) {
    const st = dragRef.current;
    if (!st) return;
    const dx = ev.clientX - st.startX;
    const dy = ev.clientY - st.startY;
    if (!st.dragging) {
      if (Math.hypot(dx, dy) < 5) return; // small threshold so plain clicks still work
      st.dragging = true;
      didDragRef.current = true;
      onPreviewGroupKeyChange(groupKey); // reveal the equivalent ghost slots
    }
    setDrag({ dx, dy });
    const target = ghostUnder(ev.clientX, ev.clientY, ev.currentTarget);
    if (target !== highlightRef.current) {
      clearHighlight();
      if (target) {
        target.style.outline = "2px solid rgba(255,255,255,0.9)";
        target.style.outlineOffset = "-2px";
        highlightRef.current = target;
      }
    }
  }

  function endDrag(ev: ReactPointerEvent<HTMLDivElement>, drop: boolean) {
    const st = dragRef.current;
    dragRef.current = null;
    if (!st || !st.dragging) return;
    const target = drop ? ghostUnder(ev.clientX, ev.clientY, ev.currentTarget) : null;
    const targetId = target?.dataset.eventId ?? null;
    clearHighlight();
    setDrag(null);
    onPreviewGroupKeyChange(null);
    if (targetId) onDeselect(targetId); // toggling the ghost on swaps the stream in student mode
  }

  return (
    <div
      data-event-card="1"
      data-event-id={e.id}
      data-group-key={groupKey}
      data-enabled={isEnabled ? "1" : "0"}
      title={isTiny ? tooltip : undefined}
      onMouseEnter={() => {
        onHoverChange(e.id);
        setCardHovered(true);
      }}
      onMouseLeave={() => {
        onHoverChange(null);
        setCardHovered(false);
      }}
      onPointerDown={onCardPointerDown}
      onPointerMove={onCardPointerMove}
      onPointerUp={(ev) => endDrag(ev, true)}
      onPointerCancel={(ev) => endDrag(ev, false)}
      onClick={() => {
        if (didDragRef.current) {
          didDragRef.current = false;
          return;
        }
        if (e.custom) {
          if (!locked) onEditEvent(e);
          return;
        }
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
        cursor: drag ? "grabbing" : canDrag ? "grab" : "pointer",
        touchAction: canDrag ? "none" : undefined,
        ...(drag
          ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, zIndex: 50, transition: "none" }
          : {}),
      }}
    >

      <button
        className={clsx(
          "absolute z-10",
          locked ? "hidden" : "opacity-0 group-hover:opacity-100 transition-opacity",
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

      {(isClashing || isClashIgnored) && !locked ? (
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
        ref={contentRef}
        className="min-w-0 pr-6 relative"
        style={{
          paddingLeft: isClashing || isClashIgnored ? 26 : 8,
          ...(overflowPx > 0
            ? {
                transform: cardHovered ? `translateY(-${overflowPx}px)` : "translateY(0)",
                transition: cardHovered
                  ? `transform ${Math.max(1, overflowPx / 35)}s ease-in-out 1s`
                  : "transform 0.25s ease",
                willChange: "transform",
              }
            : {}),
        }}
      >
        <ScrollLine
          className="text-[12px] leading-4"
          style={{ fontWeight: isHovered || isGroupHighlight ? 800 : 600 }}
          hovered={cardHovered}
          text={e.courseCode}
        />
        <ScrollLine
          className="text-[11px] text-white/80"
          style={{ fontWeight: isHovered || isGroupHighlight ? 800 : 500 }}
          hovered={cardHovered}
          text={e.classCode}
        />

        {!isTiny && (
          <>
            <ScrollLine
              className="mt-1 text-[11px] text-white/75 tabular-nums font-mono"
              hovered={cardHovered}
              text={`${formatMinutes(e.startMin)}–${formatMinutes(e.endMin)}`}
            />
            <ScrollLine
              className="mt-1 text-[11px] text-white/65"
              hovered={cardHovered}
              text={fullLocation(e)}
            />
          </>
        )}
      </div>
    </div>
  );
}
