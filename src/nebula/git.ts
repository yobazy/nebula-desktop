// Git state per worktree, polled from the app (the daemon reports none):
// the selected project's checkouts every few seconds while the window is in
// front, everything else now and then, and a checkout at once when one of its
// agents changes status — that's when commits and pushes land.
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview, onAgentStatus } from "./client";
import { getState, projectWorktrees, setState, subscribe } from "./store";
import type { Worktree } from "./types";

export interface GitStatus {
  /** Null on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  /** Configured, but deleted on the remote (typically a merged PR's branch). */
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  insertions: number;
  deletions: number;
  /** Commits on this branch that the project's main branch lacks. */
  baseAhead: number | null;
  lastCommit: { subject: string; time: number } | null;
}

export type GitState = GitStatus | { error: string };

export type ShipKind = "resolve" | "commit" | "push";

export function changedFiles(g: GitStatus): number {
  return g.staged + g.unstaged + g.untracked + g.conflicted;
}

/** Whether the branch has commits of its own that were never pushed. */
export function neverPushed(g: GitStatus, wt: Worktree): boolean {
  return !g.upstream && !wt.is_main && !!g.branch && (g.baseAhead ?? 0) > 0;
}

/** What shipping this checkout still takes, or null when there's nothing to
 *  ship — or nowhere to ship it, as on a detached HEAD. */
export function shipKind(g: GitStatus, wt: Worktree): ShipKind | null {
  if (!g.branch) return null;
  if (g.conflicted > 0) return "resolve";
  if (changedFiles(g) > 0) return "commit";
  // A deleted upstream usually means the branch was merged: pushing again
  // would only resurrect it, so only new work gets a button.
  if (g.upstreamGone) return null;
  if (g.ahead > 0 || neverPushed(g, wt)) return "push";
  return null;
}

/** The remote a push goes to: the upstream's, else origin. */
export function remoteOf(g: GitStatus): string {
  return g.upstream?.split("/")[0] || "origin";
}

const FAST_MS = 4_000;
const SLOW_MS = 30_000;
const inFlight = new Set<string>();
/** Asked for while a fetch was already running: rerun once it lands, since
 *  that fetch may predate the commit or push the ask was about. */
const again = new Set<string>();

function mainBranch(wt: Worktree): string | null {
  const s = getState();
  const main = Object.values(s.worktrees).find((w) => w.project_id === wt.project_id && w.is_main);
  return main && main.id !== wt.id ? main.branch : null;
}

async function fetchStatus(wt: Worktree): Promise<GitState> {
  try {
    if (isPreview()) {
      const { mockGitStatus } = await import("./mock");
      return mockGitStatus(wt.id);
    }
    return await invoke<GitStatus>("git_status", { path: wt.path, base: mainBranch(wt) });
  } catch (e) {
    return { error: String(e) };
  }
}

/** Refresh these checkouts, writing the store once and only for ones whose
 *  state changed — the store is replaced on every write, and each write
 *  re-renders every view. */
export async function refreshGit(ids: string[]) {
  const s = getState();
  const todo = ids.filter((id) => {
    if (!s.worktrees[id]) return false;
    if (inFlight.has(id)) {
      again.add(id);
      return false;
    }
    return true;
  });
  if (!todo.length) return;
  todo.forEach((id) => inFlight.add(id));
  const results = await Promise.all(todo.map((id) => fetchStatus(s.worktrees[id])));
  todo.forEach((id) => inFlight.delete(id));

  const prev = getState().git;
  const changed: Record<string, GitState> = {};
  todo.forEach((id, i) => {
    if (JSON.stringify(prev[id]) !== JSON.stringify(results[i])) changed[id] = results[i];
  });
  if (Object.keys(changed).length) setState((st) => ({ git: { ...st.git, ...changed } }));

  const rerun = todo.filter((id) => again.delete(id));
  if (rerun.length) void refreshGit(rerun);
}

/** Mount once: keeps `state.git` current. */
export function useGitPolling() {
  useEffect(() => {
    const selected = () => {
      const s = getState();
      return s.selectedProject ? projectWorktrees(s, s.selectedProject).map((w) => w.id) : [];
    };
    const all = () => Object.keys(getState().worktrees);

    const fast = setInterval(() => {
      if (!document.hidden && document.hasFocus()) void refreshGit(selected());
    }, FAST_MS);
    const slow = setInterval(() => {
      if (!document.hidden) void refreshGit(all());
    }, SLOW_MS);
    // Refresh when the window comes back.
    const onFocus = () => void refreshGit(selected());
    window.addEventListener("focus", onFocus);
    const offStatus = onAgentStatus((agent) => void refreshGit([agent.worktree_id]));

    // Every checkout once per Snapshot (each connect's fresh worktree list),
    // and a project's as soon as it's picked.
    let snapshots = 0;
    let project: string | null = null;
    const check = () => {
      const s = getState();
      if (s.snapshots !== snapshots) {
        snapshots = s.snapshots;
        void refreshGit(all());
      } else if (s.selectedProject !== project) {
        void refreshGit(selected());
      }
      project = s.selectedProject;
    };
    const offStore = subscribe(check);
    check();

    return () => {
      clearInterval(fast);
      clearInterval(slow);
      offStore();
      window.removeEventListener("focus", onFocus);
      offStatus();
    };
  }, []);
}
