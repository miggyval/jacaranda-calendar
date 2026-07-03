import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Download, X, Trash2, EyeOff, FileDown, FileUp, Eye } from "lucide-react";
import clsx from "clsx";
import { courseToColor } from "../lib/colors";
import { formatMinutes } from "../lib/time";
import { listSemesters, semesterValue, parseSemesterValue, type SemesterSel } from "../lib/semester";
import { searchCourses, type CourseMatch } from "../lib/uqApi";
import type { ClassEvent, PlanMode, PlanMeta } from "../lib/types";

type Props = {
  events: ClassEvent[];
  selected: Set<string>;
  hidden: Set<string>;
  onToggle: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onShowAll: () => void;
  onRemoveCourse: (courseCode: string) => void;
  hoveredId: string | null;
  onHoverChange: (id: string | null) => void;
  onImport: (file: File) => void;
  onAddCourses: (input: string) => void;
  semester: SemesterSel;
  onSemesterChange: (s: SemesterSel) => void;
  mode: PlanMode;
  onModeChange: (m: PlanMode) => void;
  ignoreClashes: boolean;
  onIgnoreClashesChange: (v: boolean) => void;
  plans: PlanMeta[];
  currentPlanId: string | null;
  onSavePlan: (name: string) => void;
  onLoadPlan: (id: string) => void;
  onDeletePlan: (id: string) => void;
  onExportPlan: () => void;
  onImportPlan: (file: File) => void;
  loading: boolean;
  error?: string | null;
  allocatedHours: number;
};

type SortMode = "numeric" | "chrono";

// Parse classCode with dash semantics:
// - Left of '-' is "class type + stream" (e.g. "PRA1")
// - Right of '-' is "class number" (e.g. "01" -> 1)
function parseClassCode(classCode: string): {
  left: string;
  rightNum: number | null;
  raw: string;
} {
  const raw = (classCode ?? "").trim();
  const s = raw.toUpperCase().replace(/\s+/g, "");

  const parts = s.split("-");
  const left = parts[0] ?? s;

  let rightNum: number | null = null;
  if (parts.length >= 2) {
    const m = (parts[1] ?? "").match(/^0*([0-9]+)$/);
    if (m) rightNum = Number(m[1]);
  }

  return { left, rightNum, raw: s };
}

// Monday-first ordering (extend if needed)
const DAY_ORDER: Record<string, number> = {
  MON: 0,
  MONDAY: 0,
  TUE: 1,
  TUESDAY: 1,
  WED: 2,
  WEDNESDAY: 2,
  THU: 3,
  THURSDAY: 3,
  FRI: 4,
  FRIDAY: 4,
  SAT: 5,
  SATURDAY: 5,
  SUN: 6,
  SUNDAY: 6,
};
const dayIndex = (d: string) => DAY_ORDER[(d ?? "").trim().toUpperCase()] ?? 99;

// Two-option segmented toggle (equal columns, so multiple stack into an aligned grid).
function Seg({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { v: string; label: string; title?: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div
      className="grid overflow-hidden rounded-lg border border-white/10"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          title={o.title}
          onClick={() => onChange(o.v)}
          className={clsx("text-center text-[11px] font-medium", value === o.v ? "ctl-on" : "ctl-seg")}
          style={{ padding: "5px 8px" }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Sidebar({
  events,
  selected,
  hidden,
  onToggle,
  onToggleHidden,
  onSelectAll,
  onClear,
  onShowAll,
  onRemoveCourse,
  hoveredId,
  onHoverChange,
  onImport,
  onAddCourses,
  semester,
  onSemesterChange,
  mode,
  onModeChange,
  ignoreClashes,
  onIgnoreClashesChange,
  plans,
  currentPlanId,
  onSavePlan,
  onLoadPlan,
  onDeletePlan,
  onExportPlan,
  onImportPlan,
  loading,
  error,
  allocatedHours,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const planInputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("numeric");
  const [courseInput, setCourseInput] = useState("");
  const [suggestions, setSuggestions] = useState<CourseMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [planName, setPlanName] = useState("");
  const [confirmCourse, setConfirmCourse] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  function submitAddCourses() {
    const v = courseInput.trim();
    if (!v) return;
    onAddCourses(v);
    setCourseInput("");
    setSuggestions([]);
    setShowSuggest(false);
  }

  function addAndReset(code: string) {
    onAddCourses(code);
    setCourseInput("");
    setSuggestions([]);
    setShowSuggest(false);
  }

  function handleSavePlan() {
    const n = planName.trim();
    if (!n) return;
    onSavePlan(n);
    setPlanName("");
  }

  // Debounced live course search (skips exact codes / links / multi-code input).
  useEffect(() => {
    const query = courseInput.trim();
    if (query.length < 3 || /[\s,]/.test(query) || /_S\d_|subject_code=/i.test(query)) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await searchCourses(query, semester);
        if (!cancelled) setSuggestions(res);
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [courseInput, semester]);

  // Remove-course confirmation dialog: focus Cancel (safe default), close on Escape.
  useEffect(() => {
    if (!confirmCourse) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmCourse(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmCourse]);

  const removeCount = confirmCourse
    ? events.filter((e) => e.courseCode === confirmCourse).length
    : 0;

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return events;
    return events.filter((e) =>
      `${e.courseCode} ${e.classCode} ${e.day} ${e.location}`
        .toLowerCase()
        .includes(query)
    );
  }, [events, q]);

  const grouped = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => {
      // 1) Course code
      const c = a.courseCode.localeCompare(b.courseCode, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (c !== 0) return c;

      // Parse class codes with dash semantics
      const pa = parseClassCode(a.classCode);
      const pb = parseClassCode(b.classCode);

      if (sortMode === "numeric") {
        // 2) Class Type/Stream (left of '-'), 3) Class Number (right of '-')
        const t = pa.left.localeCompare(pb.left, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        if (t !== 0) return t;

        const na = pa.rightNum ?? Number.POSITIVE_INFINITY;
        const nb = pb.rightNum ?? Number.POSITIVE_INFINITY;
        if (na !== nb) return na - nb;

        // Tie-breakers so order is stable/nice
        const d = dayIndex(a.day) - dayIndex(b.day);
        if (d !== 0) return d;
        if (a.startMin !== b.startMin) return a.startMin - b.startMin;
        return a.endMin - b.endMin;
      } else {
        // Chronological: day -> start -> end, then type/stream -> number
        const d = dayIndex(a.day) - dayIndex(b.day);
        if (d !== 0) return d;
        if (a.startMin !== b.startMin) return a.startMin - b.startMin;
        if (a.endMin !== b.endMin) return a.endMin - b.endMin;

        const t = pa.left.localeCompare(pb.left, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        if (t !== 0) return t;

        const na = pa.rightNum ?? Number.POSITIVE_INFINITY;
        const nb = pb.rightNum ?? Number.POSITIVE_INFINITY;
        if (na !== nb) return na - nb;

        return pa.raw.localeCompare(pb.raw, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      }
    });

    const order: string[] = [];
    const byCourse = new Map<string, ClassEvent[]>();
    for (const e of sorted) {
      if (!byCourse.has(e.courseCode)) {
        byCourse.set(e.courseCode, []);
        order.push(e.courseCode);
      }
      byCourse.get(e.courseCode)!.push(e);
    }

    return order.map((courseCode) => ({ courseCode, items: byCourse.get(courseCode)! }));
  }, [filtered, sortMode]);

  return (
    <aside className="flex h-screen w-[420px] max-w-[44vw] shrink-0 flex-col border-r border-white/10 bg-[#0b0f14]/70 backdrop-blur-xl">
      <div className="shrink-0 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-white/85">
              UQ Timetable Planner
            </div>
            <div className="mt-1 text-[11px] text-white/50">
              {events.length} classes · {selected.size} selected · {allocatedHours} hrs
            </div>
          </div>

          <button
            className="selection-ring inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10 disabled:opacity-30"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            title="Upload CSV"
          >
            <Download className="h-4 w-4" />
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              onImport(f);
              e.currentTarget.value = "";
            }}
          />
        </div>

        {/* Import from UQ: pick the semester, then add by course code, offering code, or link */}
        <div className="mt-3 flex items-center gap-2">
          <select
            value={semesterValue(semester)}
            onChange={(e) => {
              const next = parseSemesterValue(e.target.value);
              if (next) onSemesterChange(next);
            }}
            className="selection-ring w-[120px] shrink-0 rounded-lg border border-white/10 bg-black/25 px-2 py-2 text-[12px] text-white/80 outline-none"
            title="Semester to import classes for"
          >
            {listSemesters().map(({ sel, label }) => (
              <option key={semesterValue(sel)} value={semesterValue(sel)} className="bg-[#0b0f14]">
                {label}
              </option>
            ))}
          </select>

          <div className="relative min-w-0 flex-1">
            <input
              value={courseInput}
              onChange={(e) => setCourseInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAddCourses();
                if (e.key === "Escape") setShowSuggest(false);
              }}
              onFocus={() => setShowSuggest(true)}
              onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              placeholder="Add or search course…"
              disabled={loading}
              className="selection-ring w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[12px] outline-none placeholder:text-white/35 disabled:opacity-40"
            />

            {showSuggest && (searching || suggestions.length > 0) ? (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-lg border border-white/10 bg-[#0b0f14] shadow-[0_18px_40px_rgba(0,0,0,0.5)]">
                {searching && suggestions.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-white/45">Searching…</div>
                ) : null}
                {suggestions.map((s) => (
                  <button
                    key={s.course}
                    type="button"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => addAndReset(s.course)}
                    className="flex w-full items-baseline px-3 py-1.5 text-left hover:bg-white/10"
                  >
                    <span className="shrink-0 text-[12px] font-semibold text-white/85">{s.course}:</span>
                    <span className="truncate text-[11px] text-white/55" style={{ marginLeft: 6 }}>
                      {s.title}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button
            onClick={submitAddCourses}
            disabled={loading || !courseInput.trim()}
            className="selection-ring shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10 disabled:opacity-30"
            title="Fetch from UQ timetable"
          >
            Add
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="selection-ring min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[12px] outline-none placeholder:text-white/35"
          />

          <button
            className="selection-ring shrink-0 rounded-lg border border-white/10 bg-white/5 p-2 text-white/80 hover:bg-white/10 disabled:opacity-30"
            onClick={onSelectAll}
            disabled={events.length === 0}
            title="Select all"
            aria-label="Select all"
          >
            <Check className="h-4 w-4" />
          </button>

          <button
            className="selection-ring shrink-0 rounded-lg border border-white/10 bg-white/5 p-2 text-white/80 hover:bg-white/10 disabled:opacity-30"
            onClick={onClear}
            disabled={events.length === 0}
            title="Clear selection"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </button>

          <button
            className="selection-ring shrink-0 rounded-lg border border-white/10 bg-white/5 p-2 text-white/80 hover:bg-white/10 disabled:opacity-30"
            onClick={onShowAll}
            disabled={events.length === 0 || hidden.size === 0}
            title="Unhide all"
            aria-label="Unhide all"
          >
            <Eye className="h-4 w-4" />
          </button>
        </div>

        {/* Mode / Clashes / Sort — aligned label + 2-option grid */}
        <div
          className="mt-2 grid items-center"
          style={{ gridTemplateColumns: "1fr 156px", columnGap: 8, rowGap: 6 }}
        >
          <div className="text-[11px] text-white/45">Mode</div>
          <Seg
            value={mode}
            onChange={(v) => onModeChange(v as PlanMode)}
            options={[
              { v: "student", label: "Student", title: "One class per activity group (e.g. a single practical)" },
              { v: "staff", label: "Staff", title: "Select multiple classes, clashes allowed" },
            ]}
          />

          <div className="text-[11px] text-white/45">Clashes</div>
          <Seg
            value={ignoreClashes ? "ignore" : "warn"}
            onChange={(v) => onIgnoreClashesChange(v === "ignore")}
            options={[
              { v: "warn", label: "Warn", title: "Highlight overlapping selected classes" },
              { v: "ignore", label: "Ignore", title: "Ignore all clashes (no warnings)" },
            ]}
          />

          <div className="text-[11px] text-white/45">Sort</div>
          <Seg
            value={sortMode}
            onChange={(v) => setSortMode(v as SortMode)}
            options={[
              { v: "numeric", label: "Numeric", title: "Course → Type/Stream → Number" },
              { v: "chrono", label: "Chrono", title: "Day → Start time" },
            ]}
          />
        </div>

        {/* Saved plans */}
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <div className="shrink-0 text-[11px] text-white/45">Plans</div>
            <select
              value={currentPlanId ?? ""}
              onChange={(e) => {
                if (e.target.value) onLoadPlan(e.target.value);
              }}
              className="selection-ring min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 text-[11px] text-white/80 outline-none"
              title="Load a saved plan"
            >
              <option value="">{plans.length ? "Load plan…" : "No saved plans"}</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#0b0f14]">
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => currentPlanId && onDeletePlan(currentPlanId)}
              disabled={!currentPlanId}
              className="selection-ring shrink-0 rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/80 hover:bg-white/10 disabled:opacity-30"
              title="Delete selected plan"
              aria-label="Delete selected plan"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onExportPlan}
              disabled={events.length === 0}
              className="selection-ring shrink-0 rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/80 hover:bg-white/10 disabled:opacity-30"
              title="Export plan to a file (.uqplan)"
              aria-label="Export plan to a file"
            >
              <FileDown className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => planInputRef.current?.click()}
              className="selection-ring shrink-0 rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/80 hover:bg-white/10"
              title="Import plan from a file (.uqplan)"
              aria-label="Import plan from a file"
            >
              <FileUp className="h-4 w-4" />
            </button>
            <input
              ref={planInputRef}
              type="file"
              accept=".uqplan,.json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImportPlan(f);
                e.currentTarget.value = "";
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSavePlan();
              }}
              placeholder="Name this plan…"
              className="selection-ring min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-3 py-1.5 text-[11px] outline-none placeholder:text-white/35"
            />
            <button
              type="button"
              onClick={handleSavePlan}
              disabled={!planName.trim() || events.length === 0}
              className="selection-ring shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white/80 hover:bg-white/10 disabled:opacity-30"
              title="Save current timetable as a plan"
            >
              Save
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-200">
            {error}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <div
            className="sticky top-0 z-10 grid gap-2 border-b border-white/10 bg-[#0b0f14]/95 px-3 py-2 text-[11px] font-semibold text-white/50 backdrop-blur"
            style={{ gridTemplateColumns: "20px 74px 30px 78px minmax(0,1fr) auto 20px" }}
          >
            <div />
            <div>Class</div>
            <div>Day</div>
            <div>Time</div>
            <div>Location</div>
            <div />
            <div />
          </div>

          <div className="divide-y divide-white/10">
            {grouped.map((group) => (
              <div
                key={group.courseCode}
                style={{ borderLeft: `3px solid ${courseToColor(group.courseCode)}` }}
              >
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="flex min-w-0 items-center text-[13px] font-extrabold tracking-wide text-white/85">
                    <span
                      className="mr-2 inline-block shrink-0 rounded-[3px]"
                      style={{ width: 10, height: 10, background: courseToColor(group.courseCode) }}
                    />
                    <span className="shrink-0">{group.courseCode}:</span>
                    {group.items[0]?.title ? (
                      <span
                        className="truncate text-[11px] font-normal text-white/45"
                        style={{ marginLeft: 6 }}
                      >
                        {group.items[0].title}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmCourse(group.courseCode)}
                    className="shrink-0 rounded-md p-1 text-white/40 transition hover:bg-white/10"
                    title={`Remove ${group.courseCode}`}
                    aria-label={`Remove ${group.courseCode}`}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "")}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                {group.items.map((e) => {
                  const isOn = selected.has(e.id);
                  const isHidden = hidden.has(e.id);
                  const isHovered = hoveredId === e.id;

                  return (
                    <div
                      key={e.id}
                      onMouseEnter={() => onHoverChange(e.id)}
                      onMouseLeave={() => onHoverChange(null)}
                      style={{ gridTemplateColumns: "20px 74px 30px 78px minmax(0,1fr) auto 20px" }}
                      className={clsx(
                        "group grid items-center gap-2 px-3 py-2 text-[11px]",
                        "hover:bg-white/5 hover:font-bold",
                        isHovered && "bg-white/5 font-bold",
                        isOn ? "text-white/90" : "text-white/55",
                        isHidden && "opacity-60"
                      )}
                    >
                      <div>
                        <input
                          type="checkbox"
                          checked={isOn}
                          onChange={() => onToggle(e.id)}
                          className="h-4 w-4 accent-sky-400"
                          aria-label={`Toggle ${e.courseCode} ${e.classCode}`}
                        />
                      </div>

                      <div className="truncate">{e.classCode}</div>
                      <div className="truncate font-medium">{e.day}</div>
                      <div className="truncate tabular-nums font-mono">
                        {formatMinutes(e.startMin)}–{formatMinutes(e.endMin)}
                      </div>
                      <div className="min-w-0 truncate">{e.location}</div>

                      <div>
                        {e.availability !== undefined && e.availability <= 0 ? (
                          <span
                            className="rounded px-1 text-[10px] font-semibold text-red-200"
                            style={{ backgroundColor: "rgba(239,68,68,0.18)", marginRight: 16 }}
                            title="No places available"
                          >
                            Full
                          </span>
                        ) : null}
                      </div>

                      <button
                        type="button"
                        onClick={() => onToggleHidden(e.id)}
                        title={isHidden ? "Show" : "Hide"}
                        aria-label={isHidden ? `Show ${e.classCode}` : `Hide ${e.classCode}`}
                        className={clsx(
                          "rounded p-0.5 transition-opacity",
                          isHidden ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                        )}
                        style={{
                          justifySelf: "end",
                          color: isHidden ? "#c084fc" : "rgba(255,255,255,0.5)",
                        }}
                      >
                        <EyeOff size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}

            {events.length === 0 ? (
              <div className="px-3 py-6 text-[12px] text-white/55">Upload a CSV to begin.</div>
            ) : null}
          </div>
        </div>
      </div>

      {confirmCourse
        ? createPortal(
            <div
              className="fixed z-[100] flex items-center justify-center"
              style={{
                inset: 0,
                padding: "1rem",
                background: "rgba(0,0,0,0.6)",
                backdropFilter: "blur(2px)",
                WebkitBackdropFilter: "blur(2px)",
              }}
              onClick={() => setConfirmCourse(null)}
            >
              <div
                role="dialog"
                aria-modal="true"
                className="border border-white/10 bg-[#0b0f14]"
                style={{
                  width: 360,
                  maxWidth: "90vw",
                  borderRadius: 16,
                  padding: 20,
                  boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-white/90" style={{ fontSize: 14, fontWeight: 600 }}>
                  Remove {confirmCourse}?
                </div>
                <div className="text-white/55" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
                  This removes all {removeCount} {removeCount === 1 ? "class" : "classes"} for{" "}
                  <span className="text-white/80" style={{ fontWeight: 500 }}>
                    {confirmCourse}
                  </span>{" "}
                  from your timetable. Saved plans aren’t affected.
                </div>
                <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button
                    type="button"
                    ref={cancelRef}
                    onClick={() => setConfirmCourse(null)}
                    className="selection-ring border border-white/10 bg-white/5 text-white/80 hover:bg-white/10"
                    style={{ borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 500 }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onRemoveCourse(confirmCourse);
                      setConfirmCourse(null);
                    }}
                    className="selection-ring text-white"
                    style={{ borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 600, backgroundColor: "#dc2626" }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#ef4444")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#dc2626")}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </aside>
  );
}
