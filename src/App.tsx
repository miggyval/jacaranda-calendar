import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Timetable } from "./components/Timetable";
import { parseClassesCsv } from "./lib/parseCsv";
import { fetchCourseEvents } from "./lib/uqApi";
import { defaultSemester, loadSemester, saveSemester, type SemesterSel } from "./lib/semester";
import type { ClassEvent } from "./lib/types";

const LS_KEY = "uq_timetable_state_v2";

type PersistedStateV2 = {
  v: 2;
  events: ClassEvent[];
  selectedIds: string[];
  hiddenIds: string[];
};

function countAllocatedHours(events: { day: string; startMin: number; endMin: number }[]): number {
  const used = new Set<string>();
  for (const e of events) {
    const startHour = Math.floor(e.startMin / 60);
    const endHourExclusive = Math.ceil(e.endMin / 60);
    for (let h = startHour; h < endHourExclusive; h++) {
      used.add(`${e.day}|${h}`);
    }
  }
  return used.size;
}

// Merge fetched classes into the existing set, de-duping by id (existing wins).
function mergeEvents(prev: ClassEvent[], incoming: ClassEvent[]): ClassEvent[] {
  const byId = new Map(prev.map((e) => [e.id, e] as const));
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  const merged = Array.from(byId.values());
  merged.sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day);
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return a.endMin - b.endMin;
  });
  return merged;
}

export default function App() {
  const [events, setEvents] = useState<ClassEvent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // "Current semester" setting used when importing from UQ. Persisted separately.
  const [semester, setSemester] = useState<SemesterSel>(() => loadSemester() ?? defaultSemester());

  // click-preview group (course + type e.g. PRA1)
  const [previewGroupKey, setPreviewGroupKey] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;

      const parsed: PersistedStateV2 = JSON.parse(raw);
      if (!parsed || parsed.v !== 2) throw new Error("Bad version");
      if (!Array.isArray(parsed.events)) throw new Error("Bad events");
      if (!Array.isArray(parsed.selectedIds)) throw new Error("Bad selectedIds");
      if (!Array.isArray(parsed.hiddenIds)) throw new Error("Bad hiddenIds");

      for (const e of parsed.events) {
        if (
          typeof e?.id !== "string" ||
          typeof e?.courseCode !== "string" ||
          typeof e?.classCode !== "string" ||
          typeof e?.day !== "string" ||
          typeof e?.startMin !== "number" ||
          typeof e?.endMin !== "number" ||
          typeof e?.location !== "string"
        ) {
          throw new Error("Incompatible saved timetable");
        }
      }

      setEvents(parsed.events);
      setSelected(new Set(parsed.selectedIds));
      setHidden(new Set(parsed.hiddenIds));
    } catch {
      setError("Saved timetable could not be loaded (incompatible). Please upload your CSV again.");
      try {
        localStorage.removeItem(LS_KEY);
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    try {
      if (events.length === 0) {
        localStorage.removeItem(LS_KEY);
        return;
      }

      const eventsWithEnabled: ClassEvent[] = events.map((e) => ({
        ...e,
        enabled: e.enabled ? 1 : 0,
        allocatedHours: e.allocatedHours ?? (e.endMin - e.startMin) / 60,
      }));

      const payload: PersistedStateV2 = {
        v: 2,
        events: eventsWithEnabled,
        selectedIds: Array.from(selected),
        hiddenIds: Array.from(hidden),
      };

      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [events, selected, hidden]);

  useEffect(() => {
    saveSemester(semester);
  }, [semester]);

  const allIds = useMemo(() => events.map((e) => e.id), [events]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleHidden(id: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(allIds));
  }

  function clearAll() {
    setSelected(new Set());
    setPreviewGroupKey(null);
  }

  function showAll() {
    setHidden(new Set());
  }

  async function importCsv(file: File) {
    setLoading(true);
    setError(null);
    try {
      const parsed = await parseClassesCsv(file);
      setEvents(parsed);

      setSelected(new Set(parsed.filter((e) => e.enabled === 1).map((e) => e.id)));
      setHidden(new Set());
      setHoveredId(null);
      setPreviewGroupKey(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setEvents([]);
      setSelected(new Set());
      setHidden(new Set());
      setHoveredId(null);
      setPreviewGroupKey(null);
    } finally {
      setLoading(false);
    }
  }

  // Fetch one or more course codes from UQ and merge them into the current timetable.
  async function addCourses(input: string) {
    const tokens = input.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) return;

    setLoading(true);
    setError(null);

    const collected: ClassEvent[] = [];
    const errors: string[] = [];
    for (const tok of tokens) {
      try {
        collected.push(...(await fetchCourseEvents(tok, semester)));
      } catch (e: any) {
        errors.push(e?.message ?? String(e));
      }
    }

    if (collected.length > 0) {
      setEvents((prev) => mergeEvents(prev, collected));
    }
    setError(errors.length > 0 ? errors.join(" · ") : null);
    setLoading(false);
  }

  const selectedEventsForCount = useMemo(
    () => events.filter((e) => selected.has(e.id)),
    [events, selected]
  );

  const allocatedHours = useMemo(
    () => countAllocatedHours(selectedEventsForCount),
    [selectedEventsForCount]
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden text-white">
      <head>
      <link href="https://fonts.googleapis.com" rel="stylesheet"/>
      </head>
      <Sidebar
        events={events}
        selected={selected}
        hidden={hidden}
        allocatedHours={allocatedHours}
        onToggle={toggleSelected}
        onToggleHidden={toggleHidden}
        onSelectAll={selectAll}
        onClear={clearAll}
        onShowAll={showAll}
        hoveredId={hoveredId}
        onHoverChange={setHoveredId}
        onImport={importCsv}
        onAddCourses={addCourses}
        semester={semester}
        onSemesterChange={setSemester}
        loading={loading}
        error={error}
      />

      <Timetable
        events={events}
        selected={selected}
        hidden={hidden}
        hoveredId={hoveredId}
        onHoverChange={setHoveredId}
        onDeselect={(id) => toggleSelected(id)}
        previewGroupKey={previewGroupKey}
        onPreviewGroupKeyChange={setPreviewGroupKey}
      />
    </div>
  );
}
