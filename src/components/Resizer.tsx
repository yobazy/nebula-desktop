import { useEffect, useState } from "react";

/** A column width the user drags, remembered across launches. */
export interface ColumnSpec {
  key: string;
  label: string;
  initial: number;
  min: number;
  max: number;
}

export const SIDEBAR: ColumnSpec = { key: "sidebar", label: "Resize projects sidebar", initial: 252, min: 190, max: 420 };
export const SESSIONS: ColumnSpec = { key: "sessions", label: "Resize tasks column", initial: 340, min: 280, max: 640 };

const clamp = (spec: ColumnSpec, w: number) => Math.round(Math.min(spec.max, Math.max(spec.min, w)));
const storageKey = (spec: ColumnSpec) => `nebula-desktop.width.${spec.key}`;

/** The terminal never gets squeezed below this by the columns beside it. */
export const TERMINAL_MIN = 360;

export function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/** The widths actually laid out: the remembered ones, shrunk (tasks column
 *  first) until the terminal keeps its minimum in a narrow window. A hidden
 *  column (null) takes no room and lays out at 0. */
export function fitColumns(sidebar: number | null, sessions: number | null, windowWidth: number): [number, number] {
  const room = windowWidth - TERMINAL_MIN;
  const side = sidebar === null ? 0 : Math.max(SIDEBAR.min, Math.min(sidebar, room - (sessions === null ? 0 : SESSIONS.min)));
  const sess = sessions === null ? 0 : Math.max(SESSIONS.min, Math.min(sessions, room - side));
  return [side, sess];
}

export function useColumnWidth(spec: ColumnSpec): [number, (w: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey(spec)));
      if (saved) return clamp(spec, saved);
    } catch {
      // A remembered width is a convenience; start from the default.
    }
    return spec.initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(spec), String(width));
    } catch {
      // Ignore: storage may be unavailable.
    }
  }, [spec, width]);
  return [width, (w) => setWidth(clamp(spec, w))];
}

/** The drag handle on a column's right edge. Arrow keys nudge it, and a
 *  double-click puts it back. */
export function Resizer({
  spec,
  width,
  onWidth,
}: {
  spec: ColumnSpec;
  width: number;
  onWidth: (w: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`resizer${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={spec.label}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        const el = e.currentTarget;
        // Capture keeps the release even when it lands outside the window;
        // the window listeners below cover a webview that refuses it.
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Keep going on the window listeners alone.
        }
        document.body.classList.add("is-resizing");
        setDragging(true);
        // On the window, so a drag that outruns the 8px handle — or crosses
        // the terminal's canvas — stays attached.
        const move = (ev: PointerEvent) => onWidth(startW + ev.clientX - startX);
        const up = () => {
          setDragging(false);
          document.body.classList.remove("is-resizing");
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => onWidth(spec.initial)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === "ArrowLeft") onWidth(width - step);
        else if (e.key === "ArrowRight") onWidth(width + step);
        else if (e.key === "Home") onWidth(spec.min);
        else if (e.key === "End") onWidth(spec.max);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** A column hidden or shown, remembered across launches. */
export function useHidden(key: string): [boolean, (v: boolean | ((v: boolean) => boolean)) => void] {
  const storage = `nebula-desktop.hidden.${key}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(storage) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storage, hidden ? "1" : "0");
    } catch {
      // Ignore: storage may be unavailable.
    }
  }, [storage, hidden]);
  return [hidden, setHidden];
}
