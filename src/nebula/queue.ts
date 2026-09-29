// Queued follow-ups: prompts that wait for an agent's turn to end and are
// typed in as soon as it does ("then run the tests", "then commit"). The
// daemon has no queue of its own, so this app is what sends them: kept in
// localStorage across launches, and sent only while the app is open.
import { useEffect } from "react";
import { BOOTING_MS, createAgent, defaultKind, followUp, takerFor } from "./actions";
import { onAgentStatus, readSettings } from "./client";
import { flash, getState, setState } from "./store";
import type { Agent } from "./types";

export interface Queued {
  id: string;
  text: string;
  at: number;
}

const KEY = "nebula-desktop.queue";

function load(): Record<string, Queued[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function save(queue: Record<string, Queued[]>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    // Without storage the queue lasts until the app quits.
  }
}

function write(agentId: string, items: Queued[]) {
  setState((s) => {
    const queue = { ...s.queue };
    if (items.length) queue[agentId] = items;
    else delete queue[agentId];
    save(queue);
    return { queue };
  });
}

/** Whether an agent can take a prompt right now: done with its turn (or
 *  never started one) and not waiting on you. */
export function isIdle(a: Agent, now = Date.now()): boolean {
  if (a.archived) return false;
  // A fresh agent this young is most likely still booting with a prompt.
  return a.status === "finished" || (a.status === "fresh" && now - a.status_changed_at >= BOOTING_MS);
}

/** Agents a prompt is being typed into, and when this app last typed one
 *  into each: until the agent reports a status change after that, it's
 *  still "finished" only because the daemon hasn't said it's running yet. */
const sending = new Set<string>();
const lastSent = new Map<string, number>();
/** When you last typed into each agent's terminal (`noteTyped`). */
const lastTyped = new Map<string, number>();
const TYPING_MS = 10_000;

/** Called on your keystrokes into an agent's terminal: a queued prompt
 *  waits rather than land in the middle of what you're typing. */
export function noteTyped(agentId: string) {
  lastTyped.set(agentId, Date.now());
}

/** Idle, and idle since the last prompt this app sent it. */
function readyForNext(a: Agent, now = Date.now()): boolean {
  const sent = lastSent.get(a.id) ?? 0;
  // A prompt that never started a turn (the CLI swallowed it) mustn't
  // stall the queue for good: after a minute, idle is idle.
  return isIdle(a, now) && !sending.has(a.id) && (a.status_changed_at > sent || now - sent > 60_000);
}

async function type(agent: Agent, text: string, select: boolean) {
  sending.add(agent.id);
  // Stamped before typing: a turn that starts and ends before followUp
  // returns still counts as after it.
  const before = lastSent.get(agent.id);
  lastSent.set(agent.id, Date.now());
  try {
    await followUp(agent, text, { select });
  } catch (e) {
    if (before === undefined) lastSent.delete(agent.id);
    else lastSent.set(agent.id, before);
    throw e;
  } finally {
    sending.delete(agent.id);
  }
}

/** Queue `text` for `agent`, or send it now if the agent is idle and
 *  nothing is queued ahead of it. The agent is looked up afresh: a dialog
 *  may have been open for a while. Resolves with what happened. */
export async function enqueue(agent: Agent, text: string): Promise<"sent" | "queued"> {
  const s = getState();
  const now = s.agents[agent.id] ?? agent;
  const ahead = s.queue[agent.id] ?? [];
  if (!ahead.length && readyForNext(now)) {
    await type(now, text, true);
    return "sent";
  }
  write(agent.id, [...ahead, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, at: Date.now() }]);
  return "queued";
}

/** Hand `prompt` to the branch's agent like runOnWorktree does, except that
 *  an agent still mid-turn gets it queued rather than refused. Resolves with
 *  a line saying what happened. */
export async function handToBranch(worktreeId: string, prompt: string, what: string): Promise<string> {
  const taker = takerFor(getState(), worktreeId);
  if (taker.kind === "new") {
    const settings = await readSettings();
    await createAgent({ worktree: worktreeId, kind: defaultKind(settings), settings, prompt });
    return `Started an agent to ${what}`;
  }
  const how = await enqueue(taker.agent, prompt);
  return how === "sent"
    ? `Asked ${taker.agent.name} to ${what}`
    : `Queued for ${taker.agent.name}: sent when its turn ends`;
}

export function unqueue(agentId: string, id: string) {
  write(agentId, (getState().queue[agentId] ?? []).filter((q) => q.id !== id));
}

async function sendNext(agentId: string) {
  const first = getState().agents[agentId];
  const [next] = getState().queue[agentId] ?? [];
  // An agent asleep (reaped when idle) waits: waking it means attaching,
  // which would switch the terminal out from under you.
  if (!next || !first || !first.alive || !readyForNext(first)) return;
  if (Date.now() - (lastTyped.get(agentId) ?? 0) < TYPING_MS) return;
  sending.add(agentId);
  try {
    // Let the CLI settle back to its prompt before typing into it.
    await new Promise((r) => setTimeout(r, 1_200));
  } finally {
    sending.delete(agentId);
  }
  const now = getState().agents[agentId];
  const [still, ...rest] = getState().queue[agentId] ?? [];
  // It started another turn meanwhile, or the item was removed.
  if (!now || !readyForNext(now) || still?.id !== next.id) return;
  write(agentId, rest);
  try {
    await type(now, next.text, false);
    flash(`Sent the queued prompt to ${now.name}`);
  } catch (e) {
    write(agentId, [next, ...(getState().queue[agentId] ?? [])]);
    flash(`Couldn't send the queued prompt: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Mount once: loads the queue and sends each agent's next prompt when its
 *  turn finishes. */
export function useQueueRunner() {
  useEffect(() => {
    const stored = load();
    setState({ queue: stored });
    const off = onAgentStatus((agent) => {
      if (agent.status === "finished") void sendNext(agent.id);
    });
    // A sweep for what the status events can't catch: an agent that went
    // idle while the app was closed or while you were typing, one that
    // booted without a prompt, and one deleted or archived (its queue goes
    // with it).
    const sweep = setInterval(() => {
      const s = getState();
      if (!s.loaded || s.link.state !== "connected") return;
      for (const [id, items] of Object.entries(s.queue)) {
        const a = s.agents[id];
        if (!a || a.archived) {
          write(id, []);
          flash(`Dropped ${items.length} queued ${items.length === 1 ? "prompt" : "prompts"}: ${a ? `${a.name} was archived` : "its task is gone"}`);
        } else void sendNext(id);
      }
    }, 5_000);
    return () => {
      off();
      clearInterval(sweep);
    };
  }, []);
}
