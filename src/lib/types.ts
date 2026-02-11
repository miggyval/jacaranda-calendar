export type Day = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";

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
}

export interface PositionedEvent extends ClassEvent {
  col: number;   // 0..cols-1
  cols: number;  // number of parallel columns in this overlap group
}
