import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Timetable } from "./components/Timetable";
import { parseClassesCsv } from "./lib/parseCsv";
import type { ClassEvent } from "./lib/types";

const LS_KEY = "uq_timetable_selected_v1";

export default function App() {
  const [events, setEvents] = useState<ClassEvent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore selection (best effort)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const ids: string[] = JSON.parse(raw);
      if (Array.isArray(ids)) setSelected(new Set(ids));
    } catch {
      // ignore
    }
  }, []);

  // Persist selection
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(Array.from(selected)));
    } catch {
      // ignore
    }
  }, [selected]);

  const allIds = useMemo(() => events.map((e) => e.id), [events]);

  function toggle(id: string) {
    setSelected((prev) => {
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
  }

  async function importCsv(file: File) {
    setLoading(true);
    setError(null);
    try {
      const parsed = await parseClassesCsv(file);
      setEvents(parsed);

      // Default: select everything on import
      setSelected(new Set(parsed.map((e) => e.id)));
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setEvents([]);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden text-white">
      <Sidebar
        events={events}
        selected={selected}
        onToggle={toggle}
        onSelectAll={selectAll}
        onClear={clearAll}
        onImport={importCsv}
        loading={loading}
        error={error}
      />
      <Timetable events={events} selected={selected} onDeselect={(id) => toggle(id)} />
    </div>
  );
}
