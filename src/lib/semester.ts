export type SemesterCode = "S1" | "S2" | "S3";

export interface SemesterSel {
  code: SemesterCode;
  year: number;
}

const SEM_NUM: Record<SemesterCode, number> = { S1: 1, S2: 2, S3: 3 };

export function semesterLabel(s: SemesterSel): string {
  // S3 is UQ's Summer Semester, which straddles the year boundary.
  return s.code === "S3" ? `Summer ${s.year}/${s.year + 1}` : `${s.code} ${s.year}`;
}

export function semesterValue(s: SemesterSel): string {
  return `${s.code}_${s.year}`;
}

export function parseSemesterValue(v: string): SemesterSel | null {
  const [code, year] = v.split("_");
  if ((code === "S1" || code === "S2" || code === "S3") && /^\d{4}$/.test(year ?? "")) {
    return { code, year: Number(year) };
  }
  return null;
}

// Latest / most-relevant teaching period for "now":
// Jan–Apr → S1, May–Oct → S2, Nov–Dec → next year's S1.
export function defaultSemester(now: Date = new Date()): SemesterSel {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m <= 4) return { code: "S1", year: y };
  if (m <= 10) return { code: "S2", year: y };
  return { code: "S1", year: y + 1 };
}

// A tidy window of selectable semesters, sorted latest-first.
export function listSemesters(now: Date = new Date()): { sel: SemesterSel; label: string }[] {
  const y = now.getFullYear();
  const sels: SemesterSel[] = [
    { code: "S1", year: y + 1 },
    { code: "S3", year: y },
    { code: "S2", year: y },
    { code: "S1", year: y },
    { code: "S3", year: y - 1 },
    { code: "S2", year: y - 1 },
    { code: "S1", year: y - 1 },
  ];
  sels.sort((a, b) => b.year * 10 + SEM_NUM[b.code] - (a.year * 10 + SEM_NUM[a.code]));
  return sels.map((sel) => ({ sel, label: semesterLabel(sel) }));
}

const SEM_LS_KEY = "uq_semester_v1";

export function loadSemester(): SemesterSel | null {
  try {
    const raw = localStorage.getItem(SEM_LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if ((p?.code === "S1" || p?.code === "S2" || p?.code === "S3") && typeof p?.year === "number") {
      return { code: p.code, year: p.year };
    }
  } catch {
    // ignore
  }
  return null;
}

export function saveSemester(s: SemesterSel): void {
  try {
    localStorage.setItem(SEM_LS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
