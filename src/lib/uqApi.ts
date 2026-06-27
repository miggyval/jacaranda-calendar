import type { ClassEvent, Day } from "./types";
import { parseTimeToMinutes, formatMinutes } from "./time";
import { semesterLabel, type SemesterSel } from "./semester";
import { parseUqDate } from "./weeks";

// Shape of UQ's public timetable JSON (POST /aplus/rest/timetable/subjects).
export interface ApiActivity {
  subject_code: string;
  activity_group_code: string; // e.g. "PRA1", "LEC01"
  activity_code: string; // e.g. "01"
  campus: string;
  day_of_week: string; // e.g. "Tue"
  start_time: string; // "HH:MM"
  location: string; // "46-441/442/443 - Andrew N. Liveris Building"
  duration: string; // minutes, as a string
  activity_type?: string; // "Lecture", "Practical", "Recorded", ...
  activitiesDays?: string[]; // real dates, "d/m/yyyy"
  week_pattern?: string; // per-week 0/1 string
  availability?: number; // remaining seats
  selectable?: string; // "available", ...
  [k: string]: unknown;
}

export interface ApiOffering {
  subject_code: string; // full offering key
  callista_code?: string; // clean course code, e.g. "CSSE3010"
  description?: string;
  semester?: string; // "S1" | "S2" | "S3"
  campus?: string; // "STLUCIA", "EXTERNAL", ...
  activities: Record<string, ApiActivity>;
  [k: string]: unknown;
}

// Keyed by offering, e.g. "CSSE3010_S1_2026_STLUCIA_21195_IN".
export type SubjectsResponse = Record<string, ApiOffering>;

const UQ_BASE = "https://timetable.my.uq.edu.au/aplus";
const SUBJECTS_PATH = "/rest/timetable/subjects";

function runningInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function postSubjects(term: string): Promise<SubjectsResponse> {
  const body =
    `search-term=${encodeURIComponent(term)}` +
    "&semester=ALL&campus=ALL&faculty=ALL&type=ALL" +
    "&days=1&days=2&days=3&days=4&days=5&days=6&days=0" +
    "&start-time=00%3A00&end-time=23%3A00";
  const headers = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let res: Response;
    if (runningInTauri()) {
      // The Tauri HTTP plugin issues the request from Rust, bypassing browser CORS.
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      res = await tauriFetch(`${UQ_BASE}${SUBJECTS_PATH}`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } else {
      // Browser dev (npm run dev): route through the Vite proxy (see vite.config.ts).
      res = await window.fetch(`/uqapi${SUBJECTS_PATH}`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    }

    if (!res.ok) throw new Error(`UQ timetable request failed (HTTP ${res.status})`);
    return (await res.json()) as SubjectsResponse;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("UQ timetable request timed out — check your connection");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const DAYS: Record<string, Day> = {
  MON: "MON", TUE: "TUE", WED: "WED", THU: "THU", FRI: "FRI", SAT: "SAT", SUN: "SUN",
};

function toDay(s: string): Day | null {
  return DAYS[(s ?? "").slice(0, 3).toUpperCase()] ?? null;
}

function cleanLocation(loc: string): string {
  // "46-441/442/443 - Andrew N. Liveris Building" -> "46-441/442/443"; "Online" -> "Online".
  const s = (loc ?? "").trim();
  const i = s.indexOf(" - ");
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

// The building-name half of a UQ location string ("… - Andrew N. Liveris Building").
function buildingFromLocation(loc: string): string | undefined {
  const s = (loc ?? "").trim();
  const i = s.indexOf(" - ");
  return i >= 0 ? s.slice(i + 3).trim() || undefined : undefined;
}

function activityToEvent(courseCode: string, title: string | undefined, a: ApiActivity): ClassEvent | null {
  // Skip "Recorded"/delayed-viewing pseudo-classes — they duplicate the live lecture.
  if (a.activity_type === "Recorded") return null;

  const day = toDay(a.day_of_week);
  if (!day) return null;

  let startMin: number;
  try {
    startMin = parseTimeToMinutes(a.start_time);
  } catch {
    return null;
  }

  const dur = Number(a.duration);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  const endMin = startMin + dur;

  const classCode = `${a.activity_group_code}-${a.activity_code}`;
  const location = cleanLocation(a.location);
  const building = buildingFromLocation(a.location);
  // id must match parseClassesCsv's format so dedupe and saved state stay compatible.
  const id = `${courseCode}|${classCode}|${day}|${formatMinutes(startMin)}|${formatMinutes(endMin)}|${location}`;

  const activeDates = (a.activitiesDays ?? [])
    .map(parseUqDate)
    .filter((d): d is string => d !== null)
    .sort();

  return {
    id,
    courseCode,
    classCode,
    day,
    startMin,
    endMin,
    location,
    enabled: 0,
    allocatedHours: (endMin - startMin) / 60,
    ...(activeDates.length ? { activeDates } : {}),
    ...(title ? { title } : {}),
    ...(building ? { building } : {}),
    ...(typeof a.availability === "number" ? { availability: a.availability } : {}),
    ...(a.selectable ? { selectable: a.selectable } : {}),
  };
}

type ParsedInput =
  | { kind: "course"; course: string; term: string }
  | { kind: "offering"; course: string; term: string };

// Accepts a plain course code, a full offering code, or a pasted Allocate+ link.
export function parseCourseInput(raw: string): ParsedInput | null {
  let s = (raw ?? "").trim();
  if (!s) return null;

  // Pasted timetable URL, e.g. ...#subjects?subject_code=METR4201_S1_2026_STLUCIA_22185_IN
  const m = s.match(/subject_code=([A-Za-z0-9_]+)/);
  if (m) s = m[1];
  s = s.toUpperCase();

  // Full offering code: COURSE_S#_YEAR_CAMPUS_..._MODE
  const full = s.match(/^([A-Z]{3,4}\d{4})_S\d_/);
  if (full) return { kind: "offering", course: full[1], term: s };

  // Plain course code, e.g. CSSE3010.
  if (/^[A-Z]{3,4}\d{4}$/.test(s)) return { kind: "course", course: s, term: s };

  return null;
}

function offeringCourse(key: string, off: ApiOffering): string {
  return (off.callista_code ?? key.split("_")[0] ?? "").toUpperCase();
}

// Fetch a course/offering from UQ and convert it to ClassEvent[] for the chosen semester.
export async function fetchCourseEvents(rawInput: string, sem: SemesterSel): Promise<ClassEvent[]> {
  const parsed = parseCourseInput(rawInput);
  if (!parsed) {
    throw new Error(`"${rawInput.trim()}" isn't a valid course code or timetable link`);
  }

  const raw = await postSubjects(parsed.term);
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    throw new Error(`No results for ${parsed.course} on UQ's timetable`);
  }

  let chosen: [string, ApiOffering][];

  if (parsed.kind === "offering") {
    // Exact offering requested — take it as-is, no semester filtering.
    chosen = entries.filter(([key]) => key.toUpperCase() === parsed.term);
    if (chosen.length === 0) chosen = entries;
  } else {
    const forCourse = entries.filter(([key, off]) => offeringCourse(key, off) === parsed.course);
    const inSem = forCourse.filter(([key, off]) => {
      const parts = key.split("_"); // [CALLISTA, S#, YEAR, CAMPUS, id, MODE]
      const semCode = (off.semester ?? parts[1] ?? "").toUpperCase();
      const year = Number(parts[2]);
      if (semCode !== sem.code) return false;
      // Summer (S3) straddles years, so don't year-match it.
      if (sem.code !== "S3" && year !== sem.year) return false;
      return true;
    });
    if (inSem.length === 0) {
      throw new Error(`No ${semesterLabel(sem)} classes for ${parsed.course} (try another semester)`);
    }
    // Prefer St Lucia on-campus; fall back to whatever the semester offers.
    const stluciaInternal = inSem.filter(([key, off]) => {
      const parts = key.split("_");
      const mode = (parts[parts.length - 1] ?? "").toUpperCase();
      const campus = (off.campus ?? "").toUpperCase();
      return campus === "STLUCIA" && mode === "IN";
    });
    chosen = stluciaInternal.length > 0 ? stluciaInternal : inSem;
  }

  const out: ClassEvent[] = [];
  const seen = new Set<string>();
  for (const [key, off] of chosen) {
    const course = offeringCourse(key, off);
    for (const a of Object.values(off.activities ?? {})) {
      const ev = activityToEvent(course, off.description, a);
      if (ev && !seen.has(ev.id)) {
        seen.add(ev.id);
        out.push(ev);
      }
    }
  }
  if (out.length === 0) {
    throw new Error(`No usable classes found for ${parsed.course}`);
  }
  return out;
}

export interface CourseMatch {
  course: string;
  title?: string;
}

// Live search for courses offered in the chosen semester (for the Add box autocomplete).
// The UQ endpoint substring-matches code + title, so we de-dupe by course and rank code matches first.
export async function searchCourses(term: string, sem: SemesterSel): Promise<CourseMatch[]> {
  const q = (term ?? "").trim();
  if (q.length < 3) return [];

  const raw = await postSubjects(q);
  const byCourse = new Map<string, CourseMatch>();
  for (const [key, off] of Object.entries(raw)) {
    const parts = key.split("_"); // [CALLISTA, S#, YEAR, CAMPUS, id, MODE]
    const semCode = (off.semester ?? parts[1] ?? "").toUpperCase();
    const year = Number(parts[2]);
    if (semCode !== sem.code) continue;
    if (sem.code !== "S3" && year !== sem.year) continue;
    const course = offeringCourse(key, off);
    if (course && !byCourse.has(course)) byCourse.set(course, { course, title: off.description });
  }

  const upper = q.toUpperCase();
  return [...byCourse.values()]
    .sort((a, b) => {
      const ap = a.course.startsWith(upper) ? 0 : 1;
      const bp = b.course.startsWith(upper) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.course.localeCompare(b.course);
    })
    .slice(0, 30);
}
