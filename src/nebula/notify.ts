import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getState, projectOfWorktree, waitingAgents } from "./store";
import { isQuietNow } from "./quiet";
import type { Agent, AgentStatus } from "./types";

let permitted: boolean | null = null;

async function canNotify(): Promise<boolean> {
  if (permitted === null) {
    permitted = await isPermissionGranted();
    if (!permitted) permitted = (await requestPermission()) === "granted";
  }
  return permitted;
}

/** Whether the user is already looking at this agent's terminal. */
function isWatching(agent: Agent): boolean {
  const sel = getState().selectedSession;
  return document.hasFocus() && !!sel && "Agent" in sel && sel.Agent === agent.id;
}

function where(agent: Agent): string {
  const s = getState();
  const project = projectOfWorktree(s, agent.worktree_id);
  const wt = s.worktrees[agent.worktree_id];
  if (!project) return "";
  return wt && !wt.is_main ? `${project.name} on ${wt.branch}` : project.name;
}

export async function onStatusChanged(agent: Agent, from: AgentStatus) {
  updateBadge();
  if (agent.archived || isWatching(agent) || isQuietNow()) return;

  let title: string | null = null;
  if (agent.status === "needs_feedback") title = `${agent.name} is waiting on you`;
  // A finished turn only earns a banner when the app is in the background.
  else if (agent.status === "finished" && from === "running" && !document.hasFocus())
    title = `${agent.name} finished`;
  else if (agent.status === "terminated") title = `${agent.name} stopped with an error`;
  if (!title || !(await canNotify())) return;

  sendNotification({ title, body: where(agent) });
}

/** A banner of the app's own (a budget crossed), hushed in quiet hours. */
export async function notify(title: string, body: string) {
  if (isQuietNow() || !(await canNotify())) return;
  sendNotification({ title, body });
}

export function updateBadge() {
  const count = waitingAgents(getState()).length;
  try {
    getCurrentWindow()
      .setBadgeCount(count > 0 ? count : undefined)
      .catch(() => {});
  } catch {
    // Badges are best-effort: some platforms (and the browser preview) have none.
  }
}
