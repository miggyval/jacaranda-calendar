import Papa from "papaparse";
import { parseTimeToMinutes } from "./time";
import type { ClassEvent, Day } from "./types";

type RawRow = {
  CourseCode?: string;
  ClassCode?: string;
  Day?: string;
  StartTime?: string;
  EndTime?: string;
  Location?: string;
  Enabled?: string;
  [k: string]: unknown; // tolerate weird header capitalisation
};

const DAY_MAP: Record<string, Day> = {
  MON: "MON", TUE: "TUE", WED: "WED", THU: "THU", FRI: "FRI", SAT: "SAT", SUN: "SUN",
  MONDAY: "MON", TUESDAY: "TUE", WEDNESDAY: "WED", THURSDAY: "THU", FRIDAY: "FRI", SATURDAY: "SAT", SUNDAY: "SUN",
};

function getField(row: RawRow, key: string): string {
  const direct = row[key as keyof RawRow];
  if (typeof direct === "string") return direct;
  const k = Object.keys(row).find((x) => x.toLowerCase() === key.toLowerCase());
  const v = k ? (row as any)[k] : undefined;
  return typeof v === "string" ? v : "";
}

export async function parseClassesCsv(file: File): Promise<ClassEvent[]> {
  const text = await file.text();
  const res = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  if (res.errors?.length) {
    const first = res.errors[0];
    throw new Error(`CSV parse error (row ${first.row ?? "?"}): ${first.message}`);
  }

  const out: ClassEvent[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < (res.data?.length ?? 0); i++) {
    const row = res.data[i] ?? {};

    const courseCode = getField(row, "CourseCode").trim();
    const classCode = getField(row, "ClassCode").trim();
    const dayRaw = getField(row, "Day").trim().toUpperCase();
    const startRaw = getField(row, "StartTime").trim();
    const endRaw = getField(row, "EndTime").trim();
    const location = getField(row, "Location").trim();
    const enabledRaw = getField(row, "Enabled").trim();

    if (!courseCode && !classCode && !dayRaw && !startRaw && !endRaw && !location) continue;

    if (!courseCode || !classCode || !dayRaw || !startRaw || !endRaw || !location) {
      throw new Error(
        `Missing field on CSV row ${i + 2} (expected CourseCode,ClassCode,Day,StartTime,EndTime,Location)`
      );
    }

    const day = DAY_MAP[dayRaw];
    if (!day) throw new Error(`Invalid Day "${dayRaw}" on row ${i + 2}. Use MON..SUN.`);

    const startMin = parseTimeToMinutes(startRaw);
    const endMin = parseTimeToMinutes(endRaw);
    if (endMin <= startMin) throw new Error(`EndTime must be after StartTime on row ${i + 2}.`);

    const id = `${courseCode}|${classCode}|${day}|${startRaw}|${endRaw}|${location}`;
    if (seen.has(id)) continue;
    seen.add(id);

    // If the Enabled column is missing/blank, assume disabled (0)
    const enabled: 0 | 1 = enabledRaw === "" ? 0 : Number(enabledRaw) === 1 ? 1 : 0;
    const allocatedHours = (endMin - startMin) / 60;
    out.push({ id, courseCode, classCode, day, startMin, endMin, location, enabled, allocatedHours });

  }

  if (out.length === 0) {
    throw new Error("No usable rows found. Check header names and that rows are not empty.");
  }

  out.sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day);
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return a.endMin - b.endMin;
  });

  return out;
}
