// The desktop app's own arranging of the tree: projects dragged into order,
// tasks pinned to the top of their branch, task colors, and tasks marked to
// come back to. All of it lives in the desktop prefs beside the project
// icons; the daemon (and so the TUI) keeps its own order.
import { flash, getState, sortedProjects, worktreeAgents, type State } from "./store";
import { savePrefs, type DesktopPrefs } from "./theme";
import type { Agent } from "./types";

/** `ids` with `id` taken out and put back at `to`. */
function moved(ids: string[], id: string, to: number): string[] {
  const rest = ids.filter((k) => k !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  return rest;
}

/** Per-task prefs whose task is gone, dropped, so deleted tasks don't
 *  pile up in the prefs file. Left alone before the first snapshot. */
function pruned(s: State, prefs: DesktopPrefs): DesktopPrefs {
  if (!s.loaded) return prefs;
  const keep = <V>(rec: Record<string, V> | undefined) =>
    rec && Object.fromEntries(Object.entries(rec).filter(([id]) => id in s.agents));
  const pinnedTasks =
    prefs.pinnedTasks &&
    Object.fromEntries(
      Object.entries(prefs.pinnedTasks)
        .filter(([wt]) => wt in s.worktrees)
        .map(([wt, ids]) => [wt, ids.filter((id) => id in s.agents)] as const)
        .filter(([, ids]) => ids.length > 0),
    );
  const repos = new Set(Object.values(s.projects).map((p) => p.repo_path));
  return {
    ...prefs,
    projectOrder: prefs.projectOrder?.filter((r) => repos.has(r)),
    pinnedTasks,
    taskColors: keep(prefs.taskColors),
    followUps: keep(prefs.followUps),
  };
}

/** Apply `change` to the prefs and write them; a failed write is said in
 *  the notice line, and resolves false. */
async function save(change: (prefs: DesktopPrefs) => DesktopPrefs): Promise<boolean> {
  const s = getState();
  try {
    await savePrefs(pruned(s, change(s.prefs)));
    return true;
  } catch (e) {
    flash(`Couldn't save: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Put a project at `to` in the sidebar. */
export function moveProject(repo: string, to: number) {
  const order = sortedProjects(getState()).map((p) => p.repo_path);
  return save((prefs) => ({ ...prefs, projectOrder: moved(order, repo, to) }));
}

/** Put a task at `to` in its branch. Everything above where it lands is
 *  pinned there with it (so the list stays as it was left), and pinned
 *  tasks below stay pinned; the rest keep sorting themselves under them.
 *  `seen` is the order `to` counts in, when it may have re-sorted since. */
export function moveTask(agent: Agent, to: number, seen?: string[]) {
  const s = getState();
  const wt = agent.worktree_id;
  const pinned = new Set(s.prefs.pinnedTasks?.[wt]);
  pinned.add(agent.id);
  const now = worktreeAgents(s, wt).map((a) => a.id);
  const shown = seen ? [...seen.filter((id) => now.includes(id)), ...now.filter((id) => !seen.includes(id))] : now;
  const order = moved(shown, agent.id, to);
  const last = order.reduce((at, id, i) => (pinned.has(id) ? i : at), -1);
  // Pinned tasks now archived keep their pins, for if they come back.
  const away = [...pinned].filter((id) => !order.includes(id));
  return save((prefs) => ({
    ...prefs,
    pinnedTasks: { ...prefs.pinnedTasks, [wt]: [...order.slice(0, last + 1), ...away] },
  }));
}

/** Let every live task on a branch go back to sorting itself (archived
 *  ones keep their pins, for if they come back). */
export function unpinAll(worktreeId: string) {
  const { agents } = getState();
  return save((prefs) => ({
    ...prefs,
    pinnedTasks: {
      ...prefs.pinnedTasks,
      [worktreeId]: (prefs.pinnedTasks?.[worktreeId] ?? []).filter((id) => agents[id]?.archived),
    },
  }));
}

/** Back to the daemon's order for projects. */
export function resetProjectOrder() {
  return save((prefs) => ({ ...prefs, projectOrder: undefined }));
}

export function isPinned(s: State, agent: Agent): boolean {
  return s.prefs.pinnedTasks?.[agent.worktree_id]?.includes(agent.id) ?? false;
}

/** Let a pinned task go back to sorting itself. */
export function unpinTask(agent: Agent) {
  const wt = agent.worktree_id;
  return save((prefs) => ({
    ...prefs,
    pinnedTasks: { ...prefs.pinnedTasks, [wt]: (prefs.pinnedTasks?.[wt] ?? []).filter((id) => id !== agent.id) },
  }));
}

export function setTaskColor(agentId: string, name: string | null) {
  return save((prefs) => {
    const taskColors = { ...prefs.taskColors };
    if (name) taskColors[agentId] = name;
    else delete taskColors[agentId];
    return { ...prefs, taskColors };
  });
}

export function isFollowUp(s: State, agentId: string): boolean {
  return s.prefs.followUps?.[agentId] !== undefined;
}

/** Mark a task to come back to, or clear the mark. */
export function toggleFollowUp(agentId: string) {
  return save((prefs) => {
    const followUps = { ...prefs.followUps };
    if (followUps[agentId] !== undefined) delete followUps[agentId];
    else followUps[agentId] = Date.now();
    return { ...prefs, followUps };
  });
}

/** Flag a task for follow-up, or clear its flag, and say which. */
export async function toggleFlag(agent: Agent) {
  const on = !isFollowUp(getState(), agent.id);
  if (!(await toggleFollowUp(agent.id))) return;
  flash(on ? `Flagged ${agent.name} for follow-up` : `Cleared the flag on ${agent.name}`);
}

/** Every marked task still around, the longest-waiting first. */
export function followUpAgents(s: State): { agent: Agent; at: number }[] {
  return Object.entries(s.prefs.followUps ?? {})
    .flatMap(([id, at]) => (s.agents[id] ? [{ agent: s.agents[id], at }] : []))
    .sort((a, b) => a.at - b.at);
}
