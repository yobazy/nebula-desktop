// The desktop app's look: nebula's shared `theme` setting picks the accent
// (the same ten names the TUI cycles, so changing it in either app changes
// both), and a desktop-only mode picks the surfaces.
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview } from "./client";
import { loadSettings } from "./settings";
import { getState, setState, subscribe } from "./store";

export type Mode = "system" | "dark" | "black" | "light";
export const MODES: { id: Mode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "black", label: "Black" },
  { id: "light", label: "Light" },
];

/** Each TUI theme's accent (its xterm-256 color), and a deeper step of the
 *  same hue that holds contrast on the light surfaces. `default` keeps the
 *  desktop app's own periwinkle rather than the TUI's ANSI cyan. */
export const ACCENTS: Record<string, { dark: string; light: string }> = {
  default: { dark: "#9db4ff", light: "#3d5bd9" },
  ocean: { dark: "#00afff", light: "#0077b3" },
  forest: { dark: "#87d787", light: "#2f8a3a" },
  rose: { dark: "#ff87af", light: "#c2386b" },
  amber: { dark: "#ffaf00", light: "#a86a00" },
  lavender: { dark: "#afafff", light: "#5b5bd6" },
  coral: { dark: "#ff875f", light: "#c0461f" },
  slate: { dark: "#87afd7", light: "#3f6f9e" },
  sand: { dark: "#d7af87", light: "#8c6239" },
  mono: { dark: "#e6e9f2", light: "#2a2f3a" },
};

export interface DesktopPrefs {
  mode?: Mode;
  /** The sidebar cat (`Pet.tsx`); on unless turned off. */
  pet?: boolean;
  /** Icons picked for projects, by repo path (`icons.ts`). */
  projectIcons?: Record<string, ProjectIconChoice>;
}

export type ProjectIconChoice = { kind: "emoji"; value: string } | { kind: "image"; value: string };

export async function loadPrefs(): Promise<DesktopPrefs> {
  if (isPreview()) {
    try {
      return JSON.parse(localStorage.getItem("nebula-desktop.prefs") ?? "{}");
    } catch {
      return {};
    }
  }
  return invoke<DesktopPrefs>("read_desktop_prefs").catch(() => ({}));
}

export async function savePrefs(prefs: DesktopPrefs): Promise<void> {
  setState({ prefs });
  if (isPreview()) {
    try {
      localStorage.setItem("nebula-desktop.prefs", JSON.stringify(prefs));
    } catch {
      // The preview forgets; the app itself writes desktop.json.
    }
    return;
  }
  await invoke("write_desktop_prefs", { prefs });
}

const media = () => window.matchMedia("(prefers-color-scheme: light)");

/** The surfaces actually in use: `system` resolved against the OS. */
export function resolvedMode(mode: Mode | undefined): Exclude<Mode, "system"> {
  if (!mode || mode === "system") return media().matches ? "light" : "dark";
  return mode;
}

function apply() {
  const { prefs, theme } = getState();
  const mode = resolvedMode(prefs.mode);
  const accent = ACCENTS[themeName(theme)];
  const root = document.documentElement;
  root.dataset.mode = mode;
  root.style.setProperty("--accent", mode === "light" ? accent.light : accent.dark);
  root.style.setProperty("--accent-ink", mode === "light" ? "#ffffff" : "#0f1524");
  root.style.colorScheme = mode === "light" ? "light" : "dark";
  if (getState().mode !== mode) setState({ mode });
}

/** The shared accent lives in nebula's settings, which the TUI may change. */
async function loadTheme() {
  setState({ theme: themeName((await loadSettings().catch(() => ({}) as Record<string, unknown>)).theme) });
}

/** A stored theme as the TUI reads it (`Theme::by_name`): trimmed, any case,
 *  anything unknown the default. */
export function themeName(t: unknown): string {
  const name = typeof t === "string" ? t.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(ACCENTS, name) ? name : "default";
}

/** Mount once: loads the prefs and keeps the document's look in step with
 *  them, the shared theme, and the OS appearance. */
export function useTheme() {
  useEffect(() => {
    void loadPrefs().then((prefs) => setState({ prefs }));
    void loadTheme();
    const onFocus = () => void loadTheme();
    window.addEventListener("focus", onFocus);
    let last = "";
    const offStore = subscribe(() => {
      const { prefs, theme } = getState();
      const key = `${prefs.mode}|${theme}`;
      if (key !== last) {
        last = key;
        apply();
      }
    });
    apply();
    const m = media();
    const onOs = () => apply();
    m.addEventListener("change", onOs);
    return () => {
      offStore();
      window.removeEventListener("focus", onFocus);
      m.removeEventListener("change", onOs);
    };
  }, []);
}
