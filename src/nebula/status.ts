import { getState } from "./store";
import type { Agent, AgentKind, AgentStatus } from "./types";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  needs_feedback: "Waiting on you",
  running: "Working",
  finished: "Done",
  fresh: "Not started",
  terminated: "Stopped with an error",
  disconnected: "Disconnected",
};

/** Whether the agent is held at a usage limit its CLI reported but the
 *  daemon missed (limits.ts). */
export function atUsageLimit(a: Agent): boolean {
  return a.status === "needs_feedback" && !!getState().limits[a.id];
}

export function statusLabel(a: Agent): string {
  return atUsageLimit(a) ? "Hit usage limit" : STATUS_LABEL[a.status];
}

export const KIND_LABEL: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  muse: "Muse",
  grok: "Grok",
  open_code: "OpenCode",
  custom: "Custom",
};

/** The settings-key stem nebula uses for a harness (`claude_model`, …). */
export function settingsStem(kind: AgentKind): string {
  return kind === "open_code" ? "opencode" : kind;
}

export function agentSpec(a: Agent): string {
  const harness = a.custom_harness ?? KIND_LABEL[a.kind];
  return [harness, a.model, a.effort].filter(Boolean).join(", ");
}

export function lastPrompt(a: Agent): string | null {
  return a.recent_prompts.length ? a.recent_prompts[a.recent_prompts.length - 1].text : null;
}

export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d` : `${Math.round(d / 30)}mo`;
}

/** The first free `agent-N` in a worktree: the default name that makes the
 *  daemon let the agent title itself (`nebula rename`). */
export function defaultAgentName(taken: string[]): string {
  for (let n = 1; ; n++) {
    const name = `agent-${n}`;
    if (!taken.includes(name)) return name;
  }
}
