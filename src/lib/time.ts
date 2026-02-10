import type { Day } from "./types";

export const DAY_ORDER: Day[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export function parseTimeToMinutes(hhmm: string): number {
  const m = hhmm.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error(`Invalid time: "${hhmm}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h * 60 + min;
}

export function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${hh}:${mm}`;
}
