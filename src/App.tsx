import { useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Timetable } from "./components/Timetable";
import { ChangesModal } from "./components/ChangesModal";
import { parseClassesCsv } from "./lib/parseCsv";
import { fetchCourseEvents } from "./lib/uqApi";
import { defaultSemester, loadSemester, saveSemester, type SemesterSel } from "./lib/semester";
import { groupKeyOf } from "./lib/weeks";
import { diffCourses } from "./lib/refresh";
import { downloadTextFile } from "./lib/download";
import type { ClassChange, ClassEvent, EventDraft, PlanMode } from "./lib/types";

const LS_KEY = "uq_timetable_state_v2";

type PersistedStateV2 = {
  v: 2;
  events: ClassEvent[];
  selectedIds: string[];
  hiddenIds: string[];
  clashIgnoredIds?: string[];
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

const MODE_LS_KEY = "uq_mode_v1";
function loadMode(): PlanMode {
  try {
    const v = localStorage.getItem(MODE_LS_KEY);
    if (v === "student" || v === "staff") return v;
  } catch {
    // ignore
  }
  return "student";
}

const IGNORE_CLASHES_LS_KEY = "uq_ignore_clashes_v1";
function loadIgnoreClashes(): boolean {
  try {
    return localStorage.getItem(IGNORE_CLASHES_LS_KEY) === "1";
  } catch {
    return false;
  }
}

const LOCKED_LS_KEY = "uq_locked_v1";
function loadLocked(): boolean {
  try {
    return localStorage.getItem(LOCKED_LS_KEY) === "1";
  } catch {
    return false;
  }
}

// A named, self-contained snapshot of the working timetable.
type SavedPlan = {
  id: string;
  name: string;
  savedAt: number;
  events: ClassEvent[];
  selectedIds: string[];
  hiddenIds: string[];
  clashIgnoredIds: string[];
  semester: SemesterSel;
  mode: PlanMode;
};

const PLANS_LS_KEY = "uq_plans_v1";
function loadPlans(): SavedPlan[] {
  try {
    const raw = localStorage.getItem(PLANS_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p;
    }
  } catch {
    // ignore
  }
  return [];
}

// Shared shape check for events from localStorage or an imported plan file.
function isValidEvents(events: unknown): events is ClassEvent[] {
  if (!Array.isArray(events)) return false;
  return events.every(
    (e: any) =>
      typeof e?.id === "string" &&
      typeof e?.courseCode === "string" &&
      typeof e?.classCode === "string" &&
      typeof e?.day === "string" &&
      typeof e?.startMin === "number" &&
      typeof e?.endMin === "number" &&
      typeof e?.location === "string"
  );
}

// Envelope marker for exported .uqplan files.
const PLAN_FILE_APP = "uq-timetable-planner";
function newPlanId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// One undoable snapshot of the working timetable.
type Doc = {
  events: ClassEvent[];
  selectedIds: string[];
  hiddenIds: string[];
  clashIgnoredIds: string[];
};
const HISTORY_CAP = 50;

export default function App() {
  const [events, setEvents] = useState<ClassEvent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // "Current semester" setting used when importing from UQ. Persisted separately.
  const [semester, setSemester] = useState<SemesterSel>(() => loadSemester() ?? defaultSemester());

  // Student = one stream per activity group; Staff = free multi-select (clashes allowed).
  const [mode, setMode] = useState<PlanMode>(() => loadMode());

  // Clash warnings: global off-switch + a per-class set of "ignore clashes" ids.
  const [ignoreClashes, setIgnoreClashes] = useState<boolean>(() => loadIgnoreClashes());
  const [clashIgnored, setClashIgnored] = useState<Set<string>>(() => new Set());

  // Lock mode: freeze the timetable so it can't be edited by accident.
  const [locked, setLocked] = useState<boolean>(() => loadLocked());

  // Add/edit-custom-event modal (owned here so the timetable can open it on card click).
  const [eventModal, setEventModal] = useState<{ mode: "add" } | { mode: "edit"; event: ClassEvent } | null>(null);

  // Named saved plans (snapshots of the working timetable).
  const [plans, setPlans] = useState<SavedPlan[]>(() => loadPlans());
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null);

  // click-preview group (course + type e.g. PRA1)
  const [previewGroupKey, setPreviewGroupKey] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Undo/redo stacks for the working timetable (events + selection + hidden + ignored clashes).
  const [past, setPast] = useState<Doc[]>([]);
  const [future, setFuture] = useState<Doc[]>([]);
  const undoRef = useRef<() => void>(() => {});
  const redoRef = useRef<() => void>(() => {});

  // UQ refresh: re-sync loaded courses on open + on demand; `changes` non-null opens the summary modal.
  const [refreshing, setRefreshing] = useState(false);
  const [changes, setChanges] = useState<ClassChange[] | null>(null);
  const eventsRef = useRef(events);
  const semesterRef = useRef(semester);
  const refreshingRef = useRef(false);
  const refreshRef = useRef<(manual: boolean) => void>(() => {});
  eventsRef.current = events;
  semesterRef.current = semester;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;

      const parsed: PersistedStateV2 = JSON.parse(raw);
      if (!parsed || parsed.v !== 2) throw new Error("Bad version");
      if (!Array.isArray(parsed.events)) throw new Error("Bad events");
      if (!Array.isArray(parsed.selectedIds)) throw new Error("Bad selectedIds");
      if (!Array.isArray(parsed.hiddenIds)) throw new Error("Bad hiddenIds");

      if (!isValidEvents(parsed.events)) throw new Error("Incompatible saved timetable");

      setEvents(parsed.events);
      setSelected(new Set(parsed.selectedIds));
      setHidden(new Set(parsed.hiddenIds));
      setClashIgnored(new Set(parsed.clashIgnoredIds ?? []));
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
        clashIgnoredIds: Array.from(clashIgnored),
      };

      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [events, selected, hidden, clashIgnored]);

  useEffect(() => {
    saveSemester(semester);
  }, [semester]);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_LS_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode]);

  useEffect(() => {
    try {
      localStorage.setItem(IGNORE_CLASHES_LS_KEY, ignoreClashes ? "1" : "0");
    } catch {
      // ignore
    }
  }, [ignoreClashes]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCKED_LS_KEY, locked ? "1" : "0");
    } catch {
      // ignore
    }
  }, [locked]);

  useEffect(() => {
    try {
      localStorage.setItem(PLANS_LS_KEY, JSON.stringify(plans));
    } catch {
      // ignore
    }
  }, [plans]);

  function savePlan(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = plans.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    const id = existing ? existing.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot: SavedPlan = {
      id,
      name: trimmed,
      savedAt: Date.now(),
      events,
      selectedIds: Array.from(selected),
      hiddenIds: Array.from(hidden),
      clashIgnoredIds: Array.from(clashIgnored),
      semester,
      mode,
    };
    setPlans((prev) => (existing ? prev.map((p) => (p.id === id ? snapshot : p)) : [...prev, snapshot]));
    setCurrentPlanId(id);
  }

  // Load a plan snapshot into the working state (shared by load + file import).
  function applyPlan(p: SavedPlan) {
    commit();
    setEvents(p.events);
    setSelected(new Set(p.selectedIds));
    setHidden(new Set(p.hiddenIds));
    setClashIgnored(new Set(p.clashIgnoredIds ?? []));
    setSemester(p.semester);
    setMode(p.mode);
    setHoveredId(null);
    setPreviewGroupKey(null);
  }

  function loadPlan(id: string) {
    if (locked) return;
    const p = plans.find((x) => x.id === id);
    if (!p) return;
    applyPlan(p);
    setCurrentPlanId(id);
  }

  function deletePlan(id: string) {
    setPlans((prev) => prev.filter((p) => p.id !== id));
    setCurrentPlanId((cur) => (cur === id ? null : cur));
  }

  // Export the current working timetable as a portable .uqplan file.
  function exportPlan() {
    if (events.length === 0) return;
    const current = plans.find((p) => p.id === currentPlanId);
    const name = current?.name ?? "Jacaranda timetable";
    const plan: SavedPlan = {
      id: currentPlanId ?? newPlanId(),
      name,
      savedAt: Date.now(),
      events,
      selectedIds: Array.from(selected),
      hiddenIds: Array.from(hidden),
      clashIgnoredIds: Array.from(clashIgnored),
      semester,
      mode,
    };
    const envelope = { app: PLAN_FILE_APP, kind: "plan", v: 1, plan };
    const safe = name.replace(/[^a-z0-9._-]+/gi, "_");
    downloadTextFile(`${safe}.uqplan`, JSON.stringify(envelope, null, 2), "application/json");
  }

  async function importPlan(file: File) {
    if (locked) return;
    setError(null);
    try {
      const env = JSON.parse(await file.text());
      if (!env || env.app !== PLAN_FILE_APP || env.kind !== "plan" || !env.plan) {
        throw new Error("Not a recognised plan file");
      }
      const p = env.plan as SavedPlan;
      if (!isValidEvents(p.events) || !Array.isArray(p.selectedIds)) {
        throw new Error("Plan file has invalid or missing classes");
      }
      // Give it a fresh id if one with the same id already exists, so it doesn't overwrite.
      const id = plans.some((x) => x.id === p.id) ? newPlanId() : p.id ?? newPlanId();
      const plan: SavedPlan = {
        id,
        name: typeof p.name === "string" && p.name.trim() ? p.name : "Imported timetable",
        savedAt: Date.now(),
        events: p.events,
        selectedIds: p.selectedIds,
        hiddenIds: Array.isArray(p.hiddenIds) ? p.hiddenIds : [],
        clashIgnoredIds: Array.isArray(p.clashIgnoredIds) ? p.clashIgnoredIds : [],
        semester: p.semester ?? semester,
        mode: p.mode === "staff" ? "staff" : "student",
      };
      applyPlan(plan);
      setPlans((prev) => [...prev.filter((x) => x.id !== plan.id), plan]);
      setCurrentPlanId(plan.id);
    } catch (e: any) {
      setError(e?.message ?? "Could not import plan file");
    }
  }

  function snapshot(): Doc {
    return {
      events,
      selectedIds: Array.from(selected),
      hiddenIds: Array.from(hidden),
      clashIgnoredIds: Array.from(clashIgnored),
    };
  }

  function restore(d: Doc) {
    setEvents(d.events);
    setSelected(new Set(d.selectedIds));
    setHidden(new Set(d.hiddenIds));
    setClashIgnored(new Set(d.clashIgnoredIds));
    setPreviewGroupKey(null);
    setHoveredId(null);
  }

  // Record the current state as an undo point (call BEFORE a mutating action). Clears the redo stack.
  function commit() {
    const snap = snapshot();
    setPast((p) => [...p, snap].slice(-HISTORY_CAP));
    setFuture([]);
  }

  function undo() {
    if (locked || past.length === 0) return;
    const cur = snapshot();
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [cur, ...f].slice(0, HISTORY_CAP));
    restore(prev);
  }

  function redo() {
    if (locked || future.length === 0) return;
    const cur = snapshot();
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, cur].slice(-HISTORY_CAP));
    restore(next);
  }

  undoRef.current = undo;
  redoRef.current = redo;

  // Cmd/Ctrl+Z to undo, Cmd/Ctrl+Shift+Z or Ctrl+Y to redo (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undoRef.current();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redoRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const allIds = useMemo(() => events.map((e) => e.id), [events]);

  function toggleSelected(id: string) {
    if (locked) return;
    commit();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      // Student mode: one stream per activity group — drop other selected in the same group.
      if (mode === "student") {
        const target = events.find((e) => e.id === id);
        if (target) {
          const gk = groupKeyOf(target);
          for (const e of events) {
            if (e.id !== id && next.has(e.id) && groupKeyOf(e) === gk) next.delete(e.id);
          }
        }
      }
      next.add(id);
      return next;
    });
  }

  function toggleHidden(id: string) {
    if (locked) return;
    commit();
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleClashIgnore(id: string) {
    if (locked) return;
    commit();
    setClashIgnored((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (locked) return;
    commit();
    setSelected(new Set(allIds));
  }

  function clearAll() {
    if (locked) return;
    commit();
    setSelected(new Set());
    setPreviewGroupKey(null);
  }

  function showAll() {
    if (locked) return;
    commit();
    setHidden(new Set());
  }

  // Remove every class for a course from the working timetable.
  function removeCourse(courseCode: string) {
    if (locked) return;
    const removedIds = new Set(
      events.filter((e) => e.courseCode === courseCode).map((e) => e.id)
    );
    if (removedIds.size === 0) return;
    commit();
    setEvents((prev) => prev.filter((e) => e.courseCode !== courseCode));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of removedIds) next.delete(id);
      return next;
    });
    setHidden((prev) => {
      const next = new Set(prev);
      for (const id of removedIds) next.delete(id);
      return next;
    });
    setClashIgnored((prev) => {
      const next = new Set(prev);
      for (const id of removedIds) next.delete(id);
      return next;
    });
    setPreviewGroupKey(null);
    setHoveredId(null);
  }

  // ----- Custom events (meetings / consultation hours / activities) -----
  function openAddEvent() {
    if (locked) return;
    setEventModal({ mode: "add" });
  }
  function openEditEvent(event: ClassEvent) {
    setEventModal({ mode: "edit", event });
  }

  function eventFromDraft(id: string, d: EventDraft): ClassEvent {
    return {
      id,
      courseCode: d.title,
      classCode: d.category || "Event",
      day: d.day,
      startMin: d.startMin,
      endMin: d.endMin,
      location: d.location,
      custom: true,
      ...(d.date ? { activeDates: [d.date] } : {}),
    };
  }

  function addCustomEvent(d: EventDraft) {
    if (locked) return;
    commit();
    const id = `custom:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setEvents((prev) => [...prev, eventFromDraft(id, d)]);
    setSelected((prev) => new Set(prev).add(id));
    setEventModal(null);
  }

  function updateCustomEvent(id: string, d: EventDraft) {
    if (locked) return;
    commit();
    setEvents((prev) => prev.map((e) => (e.id === id ? eventFromDraft(id, d) : e)));
    setEventModal(null);
  }

  function deleteCustomEvent(id: string) {
    if (locked) return;
    commit();
    setEvents((prev) => prev.filter((e) => e.id !== id));
    setSelected((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    setHidden((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    setEventModal(null);
  }

  async function importCsv(file: File) {
    if (locked) return;
    commit();
    setLoading(true);
    setError(null);
    try {
      const parsed = await parseClassesCsv(file);
      setEvents(parsed);

      setSelected(new Set(parsed.filter((e) => e.enabled === 1).map((e) => e.id)));
      setHidden(new Set());
      setClashIgnored(new Set());
      setHoveredId(null);
      setPreviewGroupKey(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setEvents([]);
      setSelected(new Set());
      setHidden(new Set());
      setClashIgnored(new Set());
      setHoveredId(null);
      setPreviewGroupKey(null);
    } finally {
      setLoading(false);
    }
  }

  // Fetch one or more course codes from UQ and merge them into the current timetable.
  async function addCourses(input: string) {
    if (locked) return;
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
      commit();
      setEvents((prev) => mergeEvents(prev, collected));
    }
    setError(errors.length > 0 ? errors.join(" · ") : null);
    setLoading(false);
  }

  // Re-fetch every loaded (non-custom) course from UQ, diff against the current classes, apply the
  // update (migrating selections/hidden/ignored by class identity), and surface a change summary.
  // `manual` also reports "up to date" and network errors; the on-open check stays silent otherwise.
  async function refreshFromUq(manual: boolean) {
    if (refreshingRef.current) return;
    const courses = [...new Set(eventsRef.current.filter((e) => !e.custom).map((e) => e.courseCode))];
    if (courses.length === 0) {
      if (manual) setChanges([]);
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    if (manual) setError(null);

    const sem = semesterRef.current;
    const fetched: ClassEvent[] = [];
    const ok = new Set<string>();
    let anyError = false;
    for (const c of courses) {
      try {
        fetched.push(...(await fetchCourseEvents(c, sem)));
        ok.add(c);
      } catch {
        anyError = true;
      }
    }

    refreshingRef.current = false;
    setRefreshing(false);

    if (ok.size === 0) {
      if (manual) setError("Couldn't reach UQ to check for changes.");
      return;
    }

    const { events: nextEvents, changes: ch, idRemap, removedIds } = diffCourses(eventsRef.current, fetched, ok);
    const migrate = (s: Set<string>) => {
      const n = new Set<string>();
      for (const id of s) {
        if (removedIds.has(id)) continue;
        n.add(idRemap.get(id) ?? id);
      }
      return n;
    };

    if (ch.length > 0) {
      commit();
      setEvents(nextEvents);
      setSelected(migrate);
      setHidden(migrate);
      setClashIgnored(migrate);
    }
    if (ch.length > 0 || manual) setChanges(ch);
    if (manual && anyError) setError("Some courses couldn't be checked — showing what we could.");
  }

  refreshRef.current = refreshFromUq;

  // Check UQ for timetable changes once, shortly after opening (silent unless something changed).
  useEffect(() => {
    const t = setTimeout(() => refreshRef.current(false), 700);
    return () => clearTimeout(t);
  }, []);

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
        onUndo={undo}
        onRedo={redo}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        onRemoveCourse={removeCourse}
        hoveredId={hoveredId}
        onHoverChange={setHoveredId}
        onImport={importCsv}
        onAddCourses={addCourses}
        semester={semester}
        onSemesterChange={(s) => {
          if (!locked) setSemester(s);
        }}
        mode={mode}
        onModeChange={(m) => {
          if (!locked) setMode(m);
        }}
        ignoreClashes={ignoreClashes}
        onIgnoreClashesChange={setIgnoreClashes}
        plans={plans}
        currentPlanId={currentPlanId}
        onSavePlan={savePlan}
        onLoadPlan={loadPlan}
        onDeletePlan={deletePlan}
        onExportPlan={exportPlan}
        onImportPlan={importPlan}
        locked={locked}
        onToggleLocked={() => setLocked((v) => !v)}
        onOpenAddEvent={openAddEvent}
        eventModal={eventModal}
        onCloseEventModal={() => setEventModal(null)}
        onAddEvent={addCustomEvent}
        onUpdateEvent={updateCustomEvent}
        onDeleteEvent={deleteCustomEvent}
        onRefresh={() => refreshFromUq(true)}
        refreshing={refreshing}
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
        semester={semester}
        mode={mode}
        ignoreClashes={ignoreClashes}
        clashIgnored={clashIgnored}
        onToggleClashIgnore={toggleClashIgnore}
        previewGroupKey={previewGroupKey}
        onPreviewGroupKeyChange={setPreviewGroupKey}
        locked={locked}
        onEditEvent={openEditEvent}
      />

      {changes !== null ? <ChangesModal changes={changes} onClose={() => setChanges(null)} /> : null}
    </div>
  );
}
