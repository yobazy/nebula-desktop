// nebula's settings, as the TUI's settings overlay lays them out
// (nebula-tui/src/config.rs SETTINGS_TABS), so either app edits the same
// file the same way. Rows marked `tui` only change how the terminal app
// looks; the desktop app shows them so every setting has one home.
import { invoke } from "@tauri-apps/api/core";
import { isPreview, readSettings } from "./client";
import { HARNESSES } from "./actions";
import { KIND_LABEL, settingsStem } from "./status";

export type Settings = Record<string, unknown>;

export type Row =
  | { type: "bool"; key: string; label: string; hint: string; def: boolean; tui?: boolean; invert?: boolean }
  | { type: "choice"; key: string; label: string; hint: string; def: string; options: string[]; tui?: boolean }
  | { type: "text"; key: string; label: string; hint: string; def: string; placeholder?: string; suggestions?: string[]; tui?: boolean };

export const SOUNDS = ["off", "bell", "Glass", "Ping", "Pop", "Hero", "Purr", "Tink", "Submarine", "Funk", "Blow", "Bottle", "Frog", "Morse", "Sosumi", "Basso"];
export const THEMES = ["default", "ocean", "forest", "rose", "amber", "lavender", "coral", "slate", "sand", "mono"];
const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

export const GENERAL: Row[] = [
  { type: "text", key: "worktree_base_branch", label: "Worktree base branch", hint: "Branch new worktrees start from. Empty is origin's default branch.", def: "", placeholder: "auto" },
  { type: "choice", key: "editor", label: "File editor", hint: "What the TUI's file finder and ⌥click open files in. NEBULA_EDITOR overrides it.", def: "vim", options: ["vim", "nvim", "nano", "emacs", "hx"], tui: true },
  { type: "bool", key: "palette_enter_attaches", label: "Search Enter attaches", hint: "Enter in the TUI's / search opens the session in the terminal.", def: true, tui: true },
  { type: "bool", key: "close_finder_on_open", label: "Finder closes on open", hint: "Opening a file closes the TUI's finder, so quitting the editor is one Esc.", def: true, tui: true },
  { type: "bool", key: "ssh_sync_config", label: "Sync settings over ssh", hint: "nebula ssh and tunnel carry config.json and presets to the remote.", def: true },
];

export const SESSIONS: Row[] = [
  { type: "choice", key: "session_idle_timeout", label: "Idle session timeout", hint: "Stop idle sessions in worktrees nobody is looking at. Busy ones are spared.", def: "5m", options: ["off", "1m", "5m", "15m", "30m", "1h"] },
  { type: "bool", key: "prewarm_agents", label: "Warm spare agent", hint: "Keep a spare CLI booted in the selected worktree so new tasks start instantly.", def: true },
  { type: "bool", key: "prewarm_sessions", label: "Prewarm dead sessions", hint: "Boot a worktree's stopped sessions while it's selected, so attaching is instant.", def: true },
  { type: "choice", key: "done_sound", label: "Done sound", hint: "Played when a turn finishes (TUI). Off, the terminal bell, or a macOS sound.", def: "Glass", options: SOUNDS, tui: true },
  { type: "choice", key: "feedback_sound", label: "Feedback sound", hint: "Played when a turn stops to ask you (TUI). Off also silences its notification.", def: "Sosumi", options: SOUNDS, tui: true },
  { type: "choice", key: "preset_text", label: "Preset text", hint: "Where a new agent preset's text goes: before the task, after it, or both.", def: "prefix", options: ["prefix", "postfix", "prefix & postfix"] },
  { type: "bool", key: "delete_empty_worktree", label: "Delete emptied worktree", hint: "Deleting a worktree's last session deletes the worktree too, without asking.", def: false },
  { type: "bool", key: "show_all_worktrees", label: "Show all worktrees", hint: "Every worktree gets a band, even with nothing running in it.", def: true, tui: true },
];

export const TUI_APPEARANCE: Row[] = [
  { type: "bool", key: "animations", label: "Animations", hint: "Status text sweep and splash motion.", def: true, tui: true },
  { type: "bool", key: "black_background", label: "Black background", hint: "Paint the TUI pure black instead of the terminal's own background.", def: true, tui: true },
  { type: "choice", key: "session_pane", label: "Session pane", hint: "Where the TUI shows the session under the cursor.", def: "right", options: ["right", "bottom"], tui: true },
  { type: "choice", key: "worktree_layout", label: "Worktree layout", hint: "Each worktree's sessions as cards, or as a compact list.", def: "cards", options: ["cards", "list"], tui: true },
  { type: "bool", key: "card_issue_number", label: "Card issue number", hint: "Show the GitHub issue a session started from on its card.", def: true, tui: true },
  { type: "bool", key: "hide_card_marks", label: "Card marks", hint: "Show the ▶, ❯ and › marks on cards.", def: false, invert: true, tui: true },
  { type: "bool", key: "hide_draft_prs", label: "Draft pull requests", hint: "List draft pull requests alongside ready ones.", def: false, invert: true, tui: true },
];

export const AGENTS_HEAD: Row[] = [
  // Stored under the TUI's names (settingsStem), and grok is one the TUI offers too.
  { type: "choice", key: "quick_prompt_kind", label: "Default agent", hint: "The harness new tasks start with, here and in the TUI's quick prompt.", def: "claude", options: [...HARNESSES.map(settingsStem), "grok"] },
  { type: "bool", key: "quick_prompt_new_worktree", label: "New worktree by default", hint: "New tasks start on a fresh worktree instead of the project's main branch.", def: false },
  { type: "bool", key: "quick_prompt_focus", label: "Focus on launch", hint: "The TUI enters a new session's terminal when it starts.", def: false, tui: true },
  { type: "bool", key: "hide_uninstalled_harnesses", label: "Hide missing CLIs", hint: "List only harnesses found on PATH when picking an agent.", def: false },
];

/** Enabled / Model / Effort for each harness, as the Agents tab has them. */
export function harnessRows(): { title: string; rows: Row[] }[] {
  return HARNESSES.map((k) => {
    const stem = settingsStem(k);
    const rows: Row[] = [
      { type: "bool", key: `${stem}_enabled`, label: "Enabled", hint: `Offer ${KIND_LABEL[k]} when starting a task.`, def: true },
      { type: "text", key: `${stem}_model`, label: "Model", hint: "The model new sessions launch with. Empty or default is the CLI's own.", def: "default", placeholder: "default" },
    ];
    if (k !== "open_code")
      rows.push({ type: "text", key: `${stem}_effort`, label: "Effort", hint: "Reasoning effort new sessions launch with.", def: "default", placeholder: "default", suggestions: EFFORTS });
    return { title: KIND_LABEL[k], rows };
  });
}

export const EXPERIMENTAL: Row[] = [
  { type: "bool", key: "remember_harness", label: "Remember harness", hint: "A harness and model picked for a session becomes the default for the next one.", def: false },
];

export function value(s: Settings, row: Row): unknown {
  const v = s[row.key];
  return v === undefined ? row.def : v;
}

// ---- reading and writing ----

let previewSettings: Settings = { codex_enabled: true, cursor_enabled: true };

export async function loadSettings(): Promise<Settings> {
  return isPreview() ? { ...previewSettings } : readSettings();
}

/** One key, written the way the TUI writes it (settings.rs). */
export async function writeSetting(key: string, v: unknown): Promise<void> {
  if (isPreview()) {
    previewSettings = { ...previewSettings, [key]: v };
    return;
  }
  await invoke("write_setting", { key, value: v });
}

export async function writeProjectSetting(repo: string, field: string, v: string): Promise<void> {
  if (isPreview()) {
    const projects = { ...((previewSettings.projects as Record<string, Record<string, string>>) ?? {}) };
    projects[repo] = { ...(projects[repo] ?? {}), [field]: v };
    previewSettings = { ...previewSettings, projects };
    return;
  }
  await invoke("write_project_setting", { repo, field, value: v });
}

export function projectSetting(s: Settings, repo: string, field: string): string {
  const entry = (s.projects as Record<string, Record<string, unknown>> | undefined)?.[repo];
  const v = entry?.[field];
  return typeof v === "string" ? v : "";
}
