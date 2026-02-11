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

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return events;
    return events.filter((e) =>
      `${e.courseCode} ${e.classCode} ${e.day} ${e.location}`.toLowerCase().includes(query)
    );
  }, [events, q]);

  const grouped = useMemo(() => {
    const order: string[] = [];
    const byCourse = new Map<string, ClassEvent[]>();
    for (const e of filtered) {
      if (!byCourse.has(e.courseCode)) {
        byCourse.set(e.courseCode, []);
        order.push(e.courseCode);
      }
      byCourse.get(e.courseCode)!.push(e);
    }
    return order.map((courseCode) => ({ courseCode, items: byCourse.get(courseCode)! }));
  }, [filtered]);

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
            CSV
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
                <div className="px-3 py-2 text-[11px] font-bold text-white/80">
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
                    "hover:bg-white/5 hover:font-bold",        // bold on direct sidebar hover
                    isHovered && "bg-white/5 font-bold",       // bold when timetable hover drives it
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
