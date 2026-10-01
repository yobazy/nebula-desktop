import { useSyncExternalStore } from "react";
import type { GitState } from "./git";
import type { UsageReport } from "./usage";
import type { DesktopPrefs } from "./theme";
import type { PrState } from "./prs";
import type { Queued } from "./queue";
import type { FanOut } from "./fanout";
import type {
  Agent,
  AgentStatus,
  LinkState,
  Project,
  SessionRef,
  TerminalTab,
  Worktree,
} from "./types";

export interface State {
  link: LinkState;
  /** True once the first Snapshot has landed. */
  loaded: boolean;
  projects: Record<string, Project>;
  worktrees: Record<string, Worktree>;
  agents: Record<string, Agent>;
  terminals: Record<string, TerminalTab>;
  selectedProject: string | null;
  selectedSession: SessionRef | null;
  /** Bumped on every (re)connect so attached panes re-attach. */
  epoch: number;
  /** Bumped on every Snapshot: each connect's full entity list has landed. */
  snapshots: number;
  /** Git state per worktree id, from `useGitPolling`. */
  git: Record<string, GitState>;
  /** Which main view fills the space right of the sidebar. */
  view: "sessions" | "usage" | "settings" | "review" | "compare";
  /** The checkout the review view shows (Review.tsx). */
  review: string | null;
  /** Tasks fanned out over several worktrees, by group id (fanout.ts), and
   *  the group the compare view shows. */
  fanouts: Record<string, FanOut>;
  compare: string | null;
  /** The pull request on each worktree's branch, by worktree id (prs.ts). */
  prs: Record<string, PrState>;
  /** Prompts waiting for an agent's turn to end, by agent id (queue.ts). */
  queue: Record<string, Queued[]>;
  /** The last usage scan (`usage.ts`), and why the latest one failed. */
  usage: UsageReport | null;
  usageError: string | null;
  /** nebula's shared `theme` setting (the accent), and the desktop app's own prefs. */
  theme: string;
  prefs: DesktopPrefs;
  /** The surfaces in use, with "system" resolved: what the terminal matches. */
  mode: "dark" | "black" | "light";
  /** Wall clock, whole minutes: bumped each minute so time-bound views
   *  (the 5-hour window) expire on their own. */
  minute: number;
  /** Where each run terminal is serving, read off its output (runs.ts). */
  runUrls: Record<string, string>;
  /** Agents stopped at a usage limit the daemon still counts as running, by
   *  agent id: the line that said so, and the daemon's status_changed_at it
   *  was read against (limits.ts). Shown as waiting on you meanwhile. */
  limits: Record<string, { message: string; since: number }>;
  /** Each project's own logo, by repo path; null when it keeps none (icons.ts). */
  logos: Record<string, string | null>;
  /** A one-line flash at the bottom of the window, e.g. "x is already a project". */
  notice: string | null;
}

function loadFanOuts(): Record<string, FanOut> {
  try {
    const raw = JSON.parse(localStorage.getItem("nebula-desktop.fanouts") ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

const SELECTION_KEY = "nebula-desktop.selection";

function loadSelection(): Pick<State, "selectedProject" | "selectedSession"> {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Selection is a convenience; start fresh without it.
  }
  return { selectedProject: null, selectedSession: null };
}

let state: State = {
  link: { state: "connecting" },
  loaded: false,
  projects: {},
  worktrees: {},
  agents: {},
  terminals: {},
  epoch: 0,
  snapshots: 0,
  notice: null,
  git: {},
  view: "sessions",
  review: null,
  fanouts: loadFanOuts(),
  compare: null,
  prs: {},
  queue: {},
  runUrls: {},
  limits: {},
  logos: {},
  theme: "default",
  prefs: {},
  mode: "dark",
  minute: Math.floor(Date.now() / 60_000),
  usage: null,
  usageError: null,
  ...loadSelection(),
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  if ("selectedProject" in next || "selectedSession" in next) {
    try {
      localStorage.setItem(
        SELECTION_KEY,
        JSON.stringify({
          selectedProject: state.selectedProject,
          selectedSession: state.selectedSession,
        }),
      );
    } catch {
      // Ignore: storage may be unavailable.
    }
  }
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The whole state; it is replaced on every change, so derive views with
 *  useMemo keyed on it rather than selecting fresh arrays per render. */
export function useAppState(): State {
  return useSyncExternalStore(subscribe, getState);
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export function flash(notice: string) {
  if (noticeTimer) clearTimeout(noticeTimer);
  setState({ notice });
  noticeTimer = setTimeout(() => setState({ notice: null }), 3500);
}

export function byId<T extends { id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/** The state with a removed project gone, and everything under it: the
 *  daemon's database drops its worktrees, tasks and shells in the same
 *  delete but only says the project went. */
export function withoutProject(s: State, id: string): Partial<State> {
  const projects = { ...s.projects };
  delete projects[id];
  const worktrees = Object.fromEntries(Object.entries(s.worktrees).filter(([, w]) => w.project_id !== id));
  const agents = Object.fromEntries(Object.entries(s.agents).filter(([, a]) => a.worktree_id in worktrees));
  const terminals = Object.fromEntries(Object.entries(s.terminals).filter(([, t]) => t.worktree_id in worktrees));
  const sel = s.selectedSession;
  const kept = !sel || ("Agent" in sel ? sel.Agent in agents : sel.Terminal in terminals);
  return {
    projects,
    worktrees,
    agents,
    terminals,
    selectedProject: s.selectedProject === id ? (sortedProjects({ ...s, projects })[0]?.id ?? null) : s.selectedProject,
    selectedSession: kept ? sel : null,
  };
}

// ---- derived views ----

/** Projects in the order dragged into (prefs.projectOrder), the rest after
 *  them in the daemon's order. */
export function sortedProjects(s: State): Project[] {
  const daemon = Object.values(s.projects).sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  );
  return pinnedFirst(daemon, s.prefs.projectOrder, (p) => p.repo_path);
}

/** `items` with those named in `order` first, in that order; the rest keep
 *  their places after them. */
export function pinnedFirst<T>(items: T[], order: string[] | undefined, key: (t: T) => string): T[] {
  if (!order?.length) return items;
  const rank = new Map(order.map((k, i) => [k, i]));
  const pinned = items.filter((t) => rank.has(key(t))).sort((a, b) => rank.get(key(a))! - rank.get(key(b))!);
  return [...pinned, ...items.filter((t) => !rank.has(key(t)))];
}

export function projectWorktrees(s: State, projectId: string): Worktree[] {
  return Object.values(s.worktrees)
    .filter((w) => w.project_id === projectId)
    .sort(
      (a, b) =>
        Number(b.is_main) - Number(a.is_main) ||
        a.sort_order - b.sort_order ||
        a.branch.localeCompare(b.branch),
    );
}

export function projectOfWorktree(s: State, worktreeId: string): Project | undefined {
  const wt = s.worktrees[worktreeId];
  return wt ? s.projects[wt.project_id] : undefined;
}

/** How urgently a session wants attention: lower sorts first. */
export function urgency(a: Agent): number {
  if (a.status === "needs_feedback") return 0;
  if (a.status === "running") return 1;
  if (a.status === "finished" && a.unseen) return 2;
  return 3;
}

/** A branch's tasks: those pinned (dragged into place) first, in their
 *  order, then the rest by urgency. */
export function worktreeAgents(s: State, worktreeId: string, archived = false): Agent[] {
  const auto = Object.values(s.agents)
    .filter((a) => a.worktree_id === worktreeId && a.archived === archived)
    .sort(
      (a, b) =>
        urgency(a) - urgency(b) ||
        b.status_changed_at - a.status_changed_at ||
        a.sort_order - b.sort_order,
    );
  return archived ? auto : pinnedFirst(auto, s.prefs.pinnedTasks?.[worktreeId], (a) => a.id);
}

export function worktreeTerminals(s: State, worktreeId: string): TerminalTab[] {
  return Object.values(s.terminals)
    .filter((t) => t.worktree_id === worktreeId)
    .sort((a, b) => a.sort_order - b.sort_order);
}

export function projectAgents(s: State, projectId: string): Agent[] {
  const wts = new Set(
    Object.values(s.worktrees)
      .filter((w) => w.project_id === projectId)
      .map((w) => w.id),
  );
  return Object.values(s.agents).filter((a) => !a.archived && wts.has(a.worktree_id));
}

export function waitingAgents(s: State): Agent[] {
  return Object.values(s.agents)
    .filter((a) => !a.archived && a.status === "needs_feedback")
    .sort((a, b) => a.status_changed_at - b.status_changed_at);
}

export const STATUS_ORDER: AgentStatus[] = [
  "needs_feedback",
  "running",
  "finished",
  "fresh",
  "terminated",
  "disconnected",
];
