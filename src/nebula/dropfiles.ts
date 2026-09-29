// Files dropped on a terminal: their paths typed into the session, quoted
// for a shell, the way dropping onto Terminal.app does. Claude Code turns a
// dropped image path into an attachment. Tauri hands the webview the drop
// (with real paths) as its own event, not as an HTML drop.
import { useEffect } from "react";
import { isPreview, sendInput } from "./client";
import { flash, getState } from "./store";
import type { SessionRef } from "./types";

/** A path as a shell reads it: bare when safe, else single-quoted. */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Which session a point in the window drops onto: an element marked
 *  `data-drop-session` under it (the main terminal, a grid tile). */
function sessionAt(x: number, y: number): SessionRef | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-session]");
  const key = el?.dataset.dropSession;
  if (!key) return null;
  return key.startsWith("a:") ? { Agent: key.slice(2) } : { Terminal: key.slice(2) };
}

function nameOf(ref: SessionRef): string {
  const s = getState();
  return ("Agent" in ref ? s.agents[ref.Agent]?.name : s.terminals[ref.Terminal]?.name) ?? "the session";
}

/** Mark the drop target under a drag (`is-drop-target`), or none. */
function setOver(key: string | null) {
  document.querySelectorAll<HTMLElement>("[data-drop-session]").forEach((el) => {
    el.classList.toggle("is-drop-target", el.dataset.dropSession === key);
  });
}

/** Mount once: highlights the terminal a drag of files is over, and types
 *  their paths into its session on drop. */
export function useFileDrop() {
  useEffect(() => {
    if (isPreview()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const off = await getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "leave") return setOver(null);
        // Labeled physical, but on macOS wry reports the view's own points,
        // which are CSS pixels already (wry wkwebview/drag_drop.rs).
        const at = "position" in p ? sessionAt(p.position.x, p.position.y) : null;
        const key = at ? ("Agent" in at ? `a:${at.Agent}` : `t:${at.Terminal}`) : null;
        if (p.type === "enter" || p.type === "over") return setOver(key);
        setOver(null);
        if (p.type !== "drop" || !at || !p.paths.length) return;
        // A control character in a name could end the paste early and run
        // the rest as input: refuse rather than guess at quoting it.
        if (p.paths.some((path) => /[\x00-\x1f\x7f]/.test(path))) {
          flash("A dropped file's name has a control character in it, so it wasn't added");
          return;
        }
        const text = p.paths.map(shellQuote).join(" ") + " ";
        // Into an agent, a bracketed paste, so its CLI takes it as pasted
        // text (Claude Code attaches a pasted image path). A shell gets it
        // typed: a program that never turned bracketed paste on would show
        // the markers as text.
        const data = "Agent" in at ? `\x1b[200~${text}\x1b[201~` : text;
        void sendInput(at, data)
          .then(() => flash(`Added ${p.paths.length === 1 ? "a file" : `${p.paths.length} files`} to ${nameOf(at)}`))
          .catch((err) => flash(String(err)));
      });
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
