// The app's life outside its window: the menu bar icon (tray.rs) kept in
// step with what's waiting, closing to the menu bar, and a system-wide
// hotkey that brings up a new task from anywhere.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPreview } from "./client";
import { flash, getState, projectOfWorktree, subscribe, waitingAgents } from "./store";

export const QUICK_CAPTURE_DEFAULT = "Control+Alt+N";

/** The hotkeys offered in Settings, in the plugin's syntax and as macOS writes them. */
export const QUICK_CAPTURE_CHOICES: { value: string; label: string }[] = [
  { value: "Control+Alt+N", label: "⌃⌥N" },
  { value: "Control+Alt+Space", label: "⌃⌥Space" },
  { value: "Alt+Command+N", label: "⌥⌘N" },
  { value: "Control+Shift+Space", label: "⌃⇧Space" },
  { value: "off", label: "Off" },
];

export function quickCaptureKey(): string {
  return getState().prefs.quickCapture ?? QUICK_CAPTURE_DEFAULT;
}

function trayState() {
  const s = getState();
  const waiting = waitingAgents(s).map((a) => ({
    id: a.id,
    label: `${a.name} · ${projectOfWorktree(s, a.worktree_id)?.name ?? ""}`,
  }));
  const working = Object.values(s.agents).filter((a) => !a.archived && a.status === "running").length;
  return { waiting, working };
}

/** Mount once. `onCapture` opens the new-task dialog; `onOpenAgent` shows a
 *  task picked from the menu bar. */
export function useDesktopShell(onCapture: () => void, onOpenAgent: (id: string) => void) {
  // The menu bar icon, rebuilt only when what it shows changes.
  useEffect(() => {
    if (isPreview()) return;
    let last = "";
    const sync = () => {
      const state = trayState();
      const key = JSON.stringify(state);
      if (key === last) return;
      last = key;
      void invoke("update_tray", { state }).catch(() => {});
    };
    sync();
    return subscribe(sync);
  }, []);

  // Picks from the menu bar.
  useEffect(() => {
    if (isPreview()) return;
    const offs = [
      listen<string>("nebula://open-agent", (e) => onOpenAgent(e.payload)),
      listen("nebula://quick-capture", () => onCapture()),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, [onCapture, onOpenAgent]);

  // Closing the window hides it: the app keeps running in the menu bar and
  // the dock, and agents keep reporting in. ⌘Q still quits.
  useEffect(() => {
    if (isPreview()) return;
    const win = getCurrentWindow();
    const off = win.onCloseRequested((e) => {
      if (getState().prefs.keepInMenuBar === false) return;
      e.preventDefault();
      void win.hide();
    });
    return () => void off.then((f) => f());
  }, []);

  // The system-wide hotkey, re-registered when it's changed in Settings.
  // Registration goes through one queue: an unregister still in flight
  // (StrictMode's double effect, a quick change of key) would otherwise
  // land after the next register and take the new hotkey with it.
  const key = useQuickCaptureKey();
  const capture = useRef(onCapture);
  capture.current = onCapture;
  useEffect(() => {
    if (isPreview() || key === "off") return;
    void hotkeys(async (gs) => {
      if (await gs.isRegistered(key)) await gs.unregister(key);
      await gs.register(key, (e) => {
        if (e.state === "Pressed") void invoke("show_main_window").then(() => capture.current());
      });
    }).catch((e) => {
      const label = QUICK_CAPTURE_CHOICES.find((c) => c.value === key)?.label ?? key;
      flash(`Couldn't set the quick-capture hotkey ${label}; another app may have it. Pick another in Settings.`);
      console.warn("[nebula] quick-capture hotkey", key, e);
    });
    return () => void hotkeys((gs) => gs.unregister(key)).catch(() => {});
  }, [key]);
}

type GlobalShortcut = typeof import("@tauri-apps/plugin-global-shortcut");
let hotkeyQueue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every hotkey change queued before it has settled. */
function hotkeys<T>(fn: (gs: GlobalShortcut) => Promise<T>): Promise<T> {
  const next = hotkeyQueue.then(
    () => import("@tauri-apps/plugin-global-shortcut").then(fn),
    () => import("@tauri-apps/plugin-global-shortcut").then(fn),
  );
  hotkeyQueue = next.catch(() => {});
  return next;
}

/** Only the hotkey matters here: select it, rather than re-render on every store write. */
function useQuickCaptureKey(): string {
  return useSyncExternalStore(subscribe, quickCaptureKey);
}
