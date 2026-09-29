// Codex and Cursor tell nebula a turn is over through their hooks, and a
// turn cut off by a usage limit fires none: the CLI prints the limit and
// parks at its input box while the daemon keeps the row "running" for good.
// So their screens are read here instead, and an agent stopped at a limit is
// held as waiting on you (store `limits`, client.ts `held`) until the screen
// moves on or the daemon reports a status of its own.
import { useEffect } from "react";
import { statusChanged, tailOutput } from "./client";
import { getState, setState } from "./store";
import { lastRows, readScreen } from "./screen";
import type { Agent, AgentKind } from "./types";

/** The harnesses whose limit stops go unreported. Claude's hooks cover it. */
const KINDS = new Set<AgentKind>(["codex", "cursor"]);

/** What the CLIs print when they stop at a limit: Codex's "■ You've hit your
 *  usage limit. Upgrade to Pro … or try again in 2 hours" and "Quota
 *  exceeded" (API keys), Cursor's "You've hit your usage limit" and "Usage
 *  limit reached". */
const LIMIT = [
  /you[’']?ve (hit|reached) your (usage|rate) limit/i,
  /\busage limit (has been )?(reached|exceeded)/i,
  /\bquota exceeded\b/i,
];

/** The CLI is still mid-turn (retrying, say), whatever it printed above. */
const BUSY = /esc to interrupt|ctrl\+c to (stop|cancel)/i;

/** How far up from the bottom a limit notice still counts: past that, the
 *  agent has printed other things since, so it's in scrollback, not the
 *  last word. */
const ROWS = 12;

/** The limit line on screen, if the agent's last word was a usage limit. */
export function findLimit(lines: string[]): string | null {
  const rows = lastRows(lines, ROWS);
  if (rows.some((l) => BUSY.test(l))) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (LIMIT.some((re) => re.test(rows[i]))) return rows[i].replace(/^[\s■⚠✗×•▪-]+/, "").trim();
  }
  return null;
}

const POLL_MS = 4_000;
/** Per agent, the output ring position last read: the screen is only
 *  replayed when there is something new on it. */
const seen = new Map<string, number>();
/** Agents with a read still out, so a slow one isn't stacked on. */
const busy = new Set<string>();

async function check(a: Agent) {
  const held = !!getState().limits[a.id];
  // One byte is enough to learn where the ring has got to.
  const tail = await tailOutput({ Agent: a.id }, 1, null);
  if (!tail) return;
  if (seen.get(a.id) === tail.end_seq) return;
  const lines = await readScreen(a);
  if (!lines) return;
  seen.set(a.id, tail.end_seq);
  const message = findLimit(lines);
  // Re-read after the awaits: the daemon may have moved it on meanwhile.
  const now = getState().agents[a.id];
  if (!now) return;
  if (message && !held && now.status === "running") {
    const next: Agent = { ...now, status: "needs_feedback" };
    setState((s) => ({
      limits: { ...s.limits, [a.id]: { message, since: now.status_changed_at } },
      agents: { ...s.agents, [a.id]: next },
    }));
    statusChanged(next, "running");
  } else if (!message && held && getState().limits[a.id]) {
    // Sent another prompt, or the limit reset and it carried on.
    const next: Agent = { ...now, status: "running" };
    setState((s) => {
      const limits = { ...s.limits };
      delete limits[a.id];
      return { limits, agents: { ...s.agents, [a.id]: next } };
    });
    statusChanged(next, "needs_feedback");
  }
}

/** Mount once: reads the screens of Codex and Cursor agents the daemon has
 *  running, and of those held at a limit. */
export function useLimitWatch() {
  useEffect(() => {
    const t = setInterval(() => {
      const s = getState();
      const watched = Object.values(s.agents).filter(
        (a) => KINDS.has(a.kind) && a.alive && !a.archived && (a.status === "running" || s.limits[a.id]),
      );
      for (const id of seen.keys()) if (!watched.some((a) => a.id === id)) seen.delete(id);
      for (const a of watched) {
        if (busy.has(a.id)) continue;
        busy.add(a.id);
        void check(a).finally(() => busy.delete(a.id));
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);
}
