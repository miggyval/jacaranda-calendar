import { useEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ClassChange, ClassEvent } from "../lib/types";
import { formatMinutes } from "../lib/time";
import { courseToColor } from "../lib/colors";

const timeOf = (e: ClassEvent) => `${e.day} ${formatMinutes(e.startMin)}–${formatMinutes(e.endMin)}`;

function describe(c: ClassChange): { badge: string; color: string; label: string; detail: string } {
  if (c.kind === "added") {
    return { badge: "+", color: "#4ade80", label: "added", detail: `${timeOf(c.after)}${c.after.location ? ` · ${c.after.location}` : ""}` };
  }
  if (c.kind === "removed") {
    return { badge: "−", color: "#f87171", label: "removed", detail: timeOf(c.before) };
  }
  const parts: string[] = [];
  if (c.fields.includes("day") || c.fields.includes("time")) parts.push(`${timeOf(c.before)}  →  ${timeOf(c.after)}`);
  if (c.fields.includes("location")) parts.push(`${c.before.location || "—"}  →  ${c.after.location || "—"}`);
  return { badge: "✎", color: "#fbbf24", label: "changed", detail: parts.join("   ·   ") };
}

export function ChangesModal({ changes, onClose }: { changes: ClassChange[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rowStyle: CSSProperties = { display: "flex", gap: 10, padding: "8px 0", borderTop: "1px solid rgba(255,255,255,0.08)" };

  return createPortal(
    <div
      className="fixed z-[100] flex items-center justify-center"
      style={{ inset: 0, padding: "1rem", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="border border-white/10 bg-[#0b0f14]"
        style={{ width: 460, maxWidth: "92vw", borderRadius: 16, padding: 20, boxShadow: "0 24px 80px rgba(0,0,0,0.6)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-white/90" style={{ fontSize: 15, fontWeight: 700 }}>
          {changes.length ? "Timetable updated" : "You're up to date"}
        </div>

        {changes.length === 0 ? (
          <div className="text-white/55" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5 }}>
            No changes to your courses since you last checked.
          </div>
        ) : (
          <>
            <div className="text-white/55" style={{ marginTop: 6, fontSize: 12 }}>
              {changes.length} change{changes.length === 1 ? "" : "s"} found at UQ. Your selections were kept where possible.
            </div>
            <div style={{ marginTop: 12, maxHeight: "48vh", overflowY: "auto" }}>
              {changes.map((c, i) => {
                const d = describe(c);
                return (
                  <div key={i} style={rowStyle}>
                    <span style={{ color: d.color, fontWeight: 800, width: 14, textAlign: "center", flexShrink: 0 }}>{d.badge}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.9)" }}>
                        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: courseToColor(c.courseCode), marginRight: 6 }} />
                        <b>{c.courseCode}</b> {c.classCode} <span style={{ color: d.color }}>· {d.label}</span>
                      </div>
                      <div className="tabular-nums" style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>{d.detail}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            className="selection-ring text-white"
            style={{ borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 600, backgroundColor: "#7c3aed" }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
