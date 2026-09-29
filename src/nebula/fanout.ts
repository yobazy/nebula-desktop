// Fan-out: one task started on several new worktrees at once — different
// agents, or the same one more than once — so the attempts can be compared
// and the best one kept. The daemon sees ordinary worktrees and agents; the
// grouping is this app's, kept in localStorage.
import { invoke } from "@tauri-apps/api/core";
import { isPreview, request } from "./client";
import { createAgent } from "./actions";
import { useEffect } from "react";
import { getState, setState, subscribe, type State } from "./store";
import type { AgentKind } from "./types";

export interface FanOut {
  id: string;
  prompt: string;
  /** The branch name the attempts' branches were made from. */
  base: string;
  worktrees: string[];
  at: number;
}

const KEY = "nebula-desktop.fanouts";

function write(fanouts: Record<string, FanOut>) {
  setState({ fanouts });
  try {
    localStorage.setItem(KEY, JSON.stringify(fanouts));
  } catch {
    // Without storage the grouping lasts until the app quits.
  }
}

/** The group a worktree was fanned out in, while two or more of its
 *  attempts are still around to compare. */
export function fanOutOf(s: State, worktreeId: string): FanOut | null {
  for (const f of Object.values(s.fanouts)) {
    if (!f.worktrees.includes(worktreeId)) continue;
    return f.worktrees.filter((id) => s.worktrees[id]).length >= 2 ? f : null;
  }
  return null;
}

/** Short, branch-safe names for harnesses. */
const SHORT: Partial<Record<AgentKind, string>> = { open_code: "opencode" };

/** The attempts' branch names: `base-claude`, `base-codex`, and numbered
 *  when one harness runs more than once. */
export function attemptBranches(base: string, kinds: AgentKind[], copies: number): { kind: AgentKind; branch: string }[] {
  const out: { kind: AgentKind; branch: string }[] = [];
  for (const kind of kinds) {
    for (let i = 1; i <= copies; i++) {
      const name = SHORT[kind] ?? kind;
      out.push({ kind, branch: copies > 1 ? `${base}-${name}-${i}` : kinds.length > 1 ? `${base}-${name}` : `${base}-${i}` });
    }
  }
  return out;
}

/** Branch names already taken in the project: local branches, and the
 *  daemon's worktrees (in case git can't be asked). */
async function takenBranches(projectId: string): Promise<Set<string>> {
  const s = getState();
  const taken = new Set(Object.values(s.worktrees).filter((w) => w.project_id === projectId).map((w) => w.branch));
  const project = s.projects[projectId];
  if (project && !isPreview()) {
    const local = await invoke<string[]>("local_branches", { repo: project.repo_path }).catch(() => []);
    local.forEach((b) => taken.add(b));
  }
  return taken;
}

/** `name`, or `name-2`, `name-3`… — the first one not taken. */
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`)) return `${name}-${n}`;
}

/** Start the task on a new worktree per attempt, each on a branch that
 *  didn't exist before (so Keep can delete the others' branches outright).
 *  One attempt failing doesn't stop the rest. Resolves with the group of
 *  those that started, and a line for each that didn't. */
export async function fanOut(opts: {
  project: string;
  prompt: string;
  base: string;
  kinds: AgentKind[];
  copies: number;
  baseBranch: string | null;
  settings: Record<string, unknown>;
}): Promise<{ group: FanOut; failed: string[] }> {
  const group: FanOut = { id: `${Date.now()}`, prompt: opts.prompt, base: opts.base, worktrees: [], at: Date.now() };
  const failed: string[] = [];
  const taken = await takenBranches(opts.project);
  for (const attempt of attemptBranches(opts.base, opts.kinds, opts.copies)) {
    const branch = freeName(attempt.branch, taken);
    taken.add(branch);
    try {
      const created = await request("CreateWorktree", { project: opts.project, branch, base: opts.baseBranch });
      if (!created || !("Worktree" in created)) throw new Error("the daemon didn't return the worktree");
      group.worktrees.push(created.Worktree);
      await createAgent({ worktree: created.Worktree, kind: attempt.kind, settings: opts.settings, prompt: opts.prompt });
    } catch (e) {
      failed.push(`${branch}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (group.worktrees.length) write({ ...getState().fanouts, [group.id]: group });
  return { group, failed };
}

/** Keep one attempt: delete the others' worktrees (and sessions) and their
 *  branches — made fresh for this fan-out, so nothing else lives on them.
 *  The group keeps any attempt that couldn't be removed, so it can be
 *  retried; it's forgotten once only the kept one is left. */
export async function keepAttempt(groupId: string, keep: string): Promise<void> {
  const s = getState();
  const group = s.fanouts[groupId];
  if (!group) return;
  const errors: string[] = [];
  const left: string[] = [];
  for (const id of group.worktrees) {
    const wt = s.worktrees[id];
    if (id === keep || !wt) continue;
    try {
      await request("DeleteWorktree", { id, force: true });
    } catch (e) {
      errors.push(`${wt.branch}: ${e instanceof Error ? e.message : String(e)}`);
      left.push(id);
      continue;
    }
    const project = s.projects[wt.project_id];
    if (project && !isPreview()) {
      await invoke("delete_branch", { repo: project.repo_path, branch: wt.branch, force: true }).catch((e) =>
        errors.push(`${wt.branch} (branch kept): ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }
  if (left.length) write({ ...getState().fanouts, [groupId]: { ...group, worktrees: [keep, ...left] } });
  else forget(groupId);
  if (errors.length) throw new Error(`Not everything was removed. ${errors.join("; ")}`);
}

/** Mount once: prunes groups on each (re)connect's full entity list. */
export function useFanOutPrune() {
  useEffect(() => {
    let snapshots = getState().snapshots;
    return subscribe(() => {
      const s = getState();
      if (s.snapshots === snapshots) return;
      snapshots = s.snapshots;
      pruneFanOuts();
    });
  }, []);
}

/** Drop groups with nothing left to compare, once the worktrees are known. */
export function pruneFanOuts() {
  const s = getState();
  if (!s.loaded) return;
  const stale = Object.values(s.fanouts).filter((f) => f.worktrees.filter((id) => s.worktrees[id]).length < 2);
  if (!stale.length) return;
  const next = { ...s.fanouts };
  stale.forEach((f) => delete next[f.id]);
  write(next);
}

export function forget(groupId: string) {
  const next = { ...getState().fanouts };
  delete next[groupId];
  write(next);
}

export function openCompare(groupId: string) {
  setState({ view: "compare", compare: groupId });
}
