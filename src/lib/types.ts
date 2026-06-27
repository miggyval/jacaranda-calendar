export type Day = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";

export type PlanMode = "student" | "staff";

// Lightweight reference to a saved plan (for the sidebar dropdown).
export interface PlanMeta {
  id: string;
  name: string;
}

export interface ClassEvent {
  id: string;
  courseCode: string;
  classCode: string;
  day: Day;
  startMin: number; // minutes from 00:00
  endMin: number;
  location: string;
  allocatedHours?: number;
  // Optional, used for CSV import/export. App state still uses selected IDs as source of truth.
  enabled?: 0 | 1;
  // Optional metadata from the UQ scrape (absent for CSV imports).
  activeDates?: string[]; // ISO yyyy-mm-dd, sorted — the real dates this class runs
  title?: string; // course title / description
  building?: string; // full building name, e.g. "Andrew N. Liveris Building"
  availability?: number; // remaining seats (UQ "availability")
  selectable?: string; // UQ "selectable" status, e.g. "available"
}

export interface PositionedEvent extends ClassEvent {
  col: number;   // 0..cols-1
  cols: number;  // number of parallel columns in this overlap group
}
