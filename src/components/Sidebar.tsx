import { useMemo, useRef, useState } from "react";
import { Check, Download, X } from "lucide-react";
import clsx from "clsx";
import { formatMinutes } from "../lib/time";
import type { ClassEvent } from "../lib/types";

type Props = {
  events: ClassEvent[];
  selected: Set<string>;
  hidden: Set<string>;
  onToggle: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onShowAll: () => void;
  hoveredId: string | null;
  onHoverChange: (id: string | null) => void;
  onImport: (file: File) => void;
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

export function Sidebar({
  events,
  selected,
  hidden,
  onToggle,
  onToggleHidden,
  onSelectAll,
  onClear,
  onShowAll,
  hoveredId,
  onHoverChange,
  onImport,
  loading,
  error,
  allocatedHours,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("numeric");

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
    <aside className="w-[420px] max-w-[44vw] shrink-0 border-r border-white/10 bg-[#0b0f14]/70 backdrop-blur-xl">
      <div className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-white/85">
              UQ Timetable Planner
            </div>
            <div className="mt-1 text-[11px] text-white/50">
              {events.length} classes · {selected.size} selected · {allocatedHours} allocated hrs
              {loading ? <span className="ml-2 animate-pulse text-white/45">Parsing…</span> : null}
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

        <div className="mt-3 flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="selection-ring w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[12px] outline-none placeholder:text-white/35"
          />

          <button
            className="selection-ring rounded-lg border border-white/10 bg-white/5 p-2 text-white/80 hover:bg-white/10 disabled:opacity-30"
            onClick={onSelectAll}
            disabled={events.length === 0}
            title="Select all"
            aria-label="Select all"
          >
            <Check className="h-4 w-4" />
          </button>

          <button
            className="selection-ring rounded-lg border border-white/10 bg-white/5 p-2 text-white/80 hover:bg-white/10 disabled:opacity-30"
            onClick={onClear}
            disabled={events.length === 0}
            title="Clear selection"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </button>

          <button
            className="selection-ring rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] font-medium text-white/80 hover:bg-white/10 disabled:opacity-30"
            onClick={onShowAll}
            disabled={events.length === 0 || hidden.size === 0}
            title="Unhide all"
          >
            Show all
          </button>
        </div>

        {/* Sort toggle */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-[11px] text-white/45">Sort</div>

          <div className="inline-flex overflow-hidden rounded-lg border border-white/10 bg-white/5">
            <button
              type="button"
              onClick={() => setSortMode("numeric")}
              className={clsx(
                "px-3 py-1.5 text-[11px] font-medium",
                sortMode === "numeric"
                  ? "bg-white/10 text-white/85"
                  : "text-white/60 hover:bg-white/5"
              )}
              title="Course → Type/Stream → Number"
            >
              Numeric
            </button>
            <button
              type="button"
              onClick={() => setSortMode("chrono")}
              className={clsx(
                "px-3 py-1.5 text-[11px] font-medium",
                sortMode === "chrono"
                  ? "bg-white/10 text-white/85"
                  : "text-white/60 hover:bg-white/5"
              )}
              title="Day → Start time"
            >
              Chrono
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-200">
            {error}
          </div>
        ) : null}
      </div>

      <div className="h-[calc(100vh-140px)] overflow-auto px-3 pb-4">
        <div className="rounded-2xl border border-white/10 bg-white/5">
          <div className="sticky top-0 z-10 grid grid-cols-[22px_22px_86px_96px_44px_92px_1fr] gap-2 border-b border-white/10 bg-[#0b0f14]/95 px-3 py-2 text-[11px] font-semibold text-white/50 backdrop-blur">
            <div>On</div>
            <div>Hide</div>
            <div>Course</div>
            <div>Class</div>
            <div>Day</div>
            <div>Time</div>
            <div>Location</div>
          </div>

          <div className="divide-y divide-white/10">
            {grouped.map((group) => (
              <div key={group.courseCode}>
                <div className="px-3 py-2 text-[13px] font-extrabold tracking-wide text-white/85">
                  {group.courseCode}
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
                      className={clsx(
                        "grid grid-cols-[22px_22px_86px_96px_44px_92px_1fr] gap-2 px-3 py-2 text-[11px]",
                        "hover:bg-white/5 hover:font-bold",
                        isHovered && "bg-white/5 font-bold",
                        isOn ? "text-white/90" : "text-white/55",
                        isHidden && "opacity-60"
                      )}
                    >
                      <div className="pt-[2px]">
                        <input
                          type="checkbox"
                          checked={isOn}
                          onChange={() => onToggle(e.id)}
                          className="h-4 w-4 accent-sky-400"
                          aria-label={`Toggle ${e.courseCode} ${e.classCode}`}
                        />
                      </div>

                      <div className="pt-[2px]">
                        <input
                          type="checkbox"
                          checked={isHidden}
                          onChange={() => onToggleHidden(e.id)}
                          className="h-4 w-4 accent-purple-400"
                          aria-label={`Hide ${e.courseCode} ${e.classCode}`}
                          title="Hide"
                        />
                      </div>

                      <div className="truncate font-semibold">{e.courseCode}</div>
                      <div className="truncate">{e.classCode}</div>
                      <div className="truncate font-medium">{e.day}</div>
                      <div className="truncate tabular-nums font-mono">
                        {formatMinutes(e.startMin)}–{formatMinutes(e.endMin)}
                      </div>
                      <div className="truncate">{e.location}</div>
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
    </aside>
  );
}
