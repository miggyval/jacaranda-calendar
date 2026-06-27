import type { ClassEvent } from "./types";

// "d/m/yyyy" (UQ activitiesDays format) -> "yyyy-mm-dd". null if unparseable.
export function parseUqDate(s: string): string | null {
  const m = (s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isoOf(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate()
  ).padStart(2, "0")}`;
}

// Monday (week start) of an ISO date, as ISO. Local-time safe.
export function mondayISO(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  const dow = (dt.getDay() + 6) % 7; // 0=Mon .. 6=Sun
  dt.setDate(dt.getDate() - dow);
  return isoOf(dt);
}

export interface WeekOption {
  weekStartISO: string;
  index: number; // 1-based teaching-week number
  label: string; // "W1"
}

// Distinct Mondays across all events' activeDates, sorted, numbered W1..Wn.
export function deriveWeeks(events: ClassEvent[]): WeekOption[] {
  const mondays = new Set<string>();
  for (const e of events) {
    for (const d of e.activeDates ?? []) mondays.add(mondayISO(d));
  }
  return [...mondays].sort().map((weekStartISO, i) => ({
    weekStartISO,
    index: i + 1,
    label: `W${i + 1}`,
  }));
}

// Is the event active during the Mon–Sun week starting weekStartISO?
// Events without dates (CSV imports) are treated as always-on.
export function eventActiveInWeek(e: ClassEvent, weekStartISO: string): boolean {
  if (!e.activeDates || e.activeDates.length === 0) return true;
  return e.activeDates.some((d) => mondayISO(d) === weekStartISO);
}

export function isCurrentWeek(weekStartISO: string, now: Date = new Date()): boolean {
  const start = new Date(`${weekStartISO}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return now >= start && now < end;
}

export function weekRangeLabel(weekStartISO: string): string {
  const start = new Date(`${weekStartISO}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

// Activity-group key, e.g. "CSSE3010::PRA01" — one stream per group in student mode.
// Split practicals ("…-P1" / "…-P2") are separate sessions you attend together, so the
// part suffix is treated as a distinct class type: "ENGG1300::PRA01-P1" vs "…::PRA01-P2".
// That lets the user pick one of each part rather than them being mutually exclusive.
export function groupKeyOf(e: ClassEvent): string {
  const parts = e.classCode.split("-");
  const type = parts[0] ?? e.classCode;
  const last = parts[parts.length - 1] ?? "";
  const part = parts.length >= 3 && /^P\d+$/i.test(last) ? `-${last.toUpperCase()}` : "";
  return `${e.courseCode}::${type}${part}`;
}

function overlaps(a: ClassEvent, b: ClassEvent): boolean {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

// Do two events share at least one teaching week? No-date events assume yes.
function shareWeek(a: ClassEvent, b: ClassEvent): boolean {
  if (!a.activeDates?.length || !b.activeDates?.length) return true;
  const wa = new Set(a.activeDates.map(mondayISO));
  return b.activeDates.some((d) => wa.has(mondayISO(d)));
}

// Ids of events that clash (same day + overlapping time in a shared week) with another in the set.
// Events whose id is in `ignored` are excluded entirely — they neither clash nor cause clashes.
export function clashingIds(events: ClassEvent[], ignored?: Set<string>): Set<string> {
  const list = ignored && ignored.size ? events.filter((e) => !ignored.has(e.id)) : events;
  const out = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (overlaps(a, b) && shareWeek(a, b)) {
        out.add(a.id);
        out.add(b.id);
      }
    }
  }
  return out;
}
