import type { Agent } from "./types";

/** A persisted active status isn't evidence of a live session. Preserve
 * completion/error history, but don't show work or prompts on a lost session.
 * A fresh daemon snapshot restores the authoritative status on reconnect. */
export function withSessionStatus(agent: Agent, connected = true): Agent {
  if ((!connected || !agent.alive) && (agent.status === "running" || agent.status === "needs_feedback")) {
    return { ...agent, status: "disconnected" };
  }
  return agent;
}

export function disconnectedAgents(agents: Record<string, Agent>): Record<string, Agent> {
  return Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, withSessionStatus(agent, false)]));
}
