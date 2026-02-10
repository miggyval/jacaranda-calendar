import type { ClassEvent, Day, PositionedEvent } from "./types";
import { DAY_ORDER } from "./time";

export function daysInData(events: ClassEvent[]): Day[] {
  // Always show Mon–Fri (typical teaching timetable). Add weekend only if present in CSV.
  const set = new Set<Day>();
  for (const e of events) set.add(e.day);

  const base: Day[] = ["MON", "TUE", "WED", "THU", "FRI"];
  const weekend: Day[] = (["SAT", "SUN"].filter((d) => set.has(d)) as Day[]);
  return [...base, ...weekend];
}

export function computeAutoTimeRange(events: ClassEvent[]): { start: number; end: number } {
  if (events.length === 0) return { start: 8 * 60, end: 19 * 60 };

  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    min = Math.min(min, e.startMin);
    max = Math.max(max, e.endMin);
  }

  // pad a bit, clamp to sane bounds
  const start = Math.max(5 * 60, Math.floor((min - 30) / 60) * 60);
  const end = Math.min(23 * 60, Math.ceil((max + 30) / 60) * 60);
  return { start, end };
}

export function layoutEventsByDay(events: ClassEvent[]): Record<Day, PositionedEvent[]> {
  const byDay: Record<Day, ClassEvent[]> = {
    MON: [], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [],
  };
  for (const e of events) byDay[e.day].push(e);

  const out: Record<Day, PositionedEvent[]> = {
    MON: [], TUE: [], WED: [], THU: [], FRI: [], SAT: [], SUN: [],
  };

  for (const day of DAY_ORDER) out[day] = layoutOneDay(byDay[day]);
  return out;
}

// Greedy column layout within each connected overlap group.
function layoutOneDay(dayEvents: ClassEvent[]): PositionedEvent[] {
  if (dayEvents.length === 0) return [];

  const events = [...dayEvents].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Build connected overlap groups
  const groups: ClassEvent[][] = [];
  let current: ClassEvent[] = [];
  let currentEnd = -Infinity;

  for (const e of events) {
    if (current.length === 0) {
      current = [e];
      currentEnd = e.endMin;
      continue;
    }
    if (e.startMin >= currentEnd) {
      groups.push(current);
      current = [e];
      currentEnd = e.endMin;
    } else {
      current.push(e);
      currentEnd = Math.max(currentEnd, e.endMin);
    }
  }
  if (current.length) groups.push(current);

  const positioned: PositionedEvent[] = [];

  for (const g of groups) {
    const colsEnd: number[] = [];
    const colFor = new Map<string, number>();

    for (const e of g) {
      let col = colsEnd.findIndex((end) => end <= e.startMin);
      if (col === -1) {
        col = colsEnd.length;
        colsEnd.push(e.endMin);
      } else {
        colsEnd[col] = e.endMin;
      }
      colFor.set(e.id, col);
    }

    const cols = colsEnd.length;
    for (const e of g) positioned.push({ ...e, col: colFor.get(e.id) ?? 0, cols });
  }

  return positioned;
}
