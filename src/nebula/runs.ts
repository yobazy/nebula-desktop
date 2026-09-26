// Starting a project: nebula's RUN COMMAND (a project's `run_command`
// setting, else the checkout's `.nebula.json` "run") in the worktree's RUN
// TERMINAL. Where it's being served is read off that terminal's output — the
// "Local: http://localhost:5173/" dev servers print — without attaching to it.
import { useEffect } from "react";
import { request, tailOutput } from "./client";
import { getState, projectWorktrees, setState, type State } from "./store";
import type { TerminalTab } from "./types";

/** The worktree's run terminal, if it has one (running or exited). */
export function runTerminal(s: State, worktreeId: string): TerminalTab | undefined {
  return Object.values(s.terminals).find((t) => t.worktree_id === worktreeId && t.run_command !== null);
}

export class NoRunCommand extends Error {}

/** Start (or find already running) the worktree's run command. Rejects
 *  with NoRunCommand when the project has none set anywhere. */
export async function startRun(worktreeId: string): Promise<void> {
  forget(runTerminal(getState(), worktreeId)?.id);
  try {
    await request("StartRun", { worktree: worktreeId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("no run command")) throw new NoRunCommand(msg);
    throw e;
  }
}

export async function stopRun(worktreeId: string): Promise<void> {
  const term = runTerminal(getState(), worktreeId);
  await request("StopRun", { worktree: worktreeId });
  forget(term?.id);
}

/** Drop what was read from a run terminal, so a restart can't show the last
 *  run's address before the new server prints its own. */
function forget(termId: string | undefined) {
  if (!termId) return;
  seen.delete(termId);
  if (getState().runUrls[termId]) setState((s) => ({ runUrls: omit(s.runUrls, termId) }));
}

function omit<T>(rows: Record<string, T>, key: string): Record<string, T> {
  const next = { ...rows };
  delete next[key];
  return next;
}

// ---- where it's live ----

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/g;

const clean = (url: string) =>
  url.replace(/[.,;:]+$/, "").replace("0.0.0.0", "localhost").replace(/\[::1?\]/, "localhost");

/** The address a browser can open, from a dev server's output: the one on
 *  a "Local:" line (Vite, Next, Astro) when there is one, else the first
 *  local URL printed — later ones are more often requests it logged. */
export function findLocalUrl(text: string): string | null {
  const plain = text.replace(ANSI, "");
  for (const line of plain.split(/\r?\n/)) {
    if (/\blocal\b\s*:/i.test(line)) {
      const m = line.match(LOCAL_URL);
      if (m) return clean(m[0]);
    }
  }
  const m = plain.match(LOCAL_URL);
  return m ? clean(m[0]) : null;
}

const POLL_MS = 2_000;
/** Per run terminal: the ring position last read, and what came before it,
 *  since a URL can straddle two reads. */
const seen = new Map<string, { seq: number | null; carry: string; decoder: TextDecoder }>();

async function watch(term: TerminalTab) {
  // One streaming decoder per terminal, so a character split across two
  // reads decodes whole.
  const at = seen.get(term.id) ?? { seq: null, carry: "", decoder: new TextDecoder() };
  const tail = await tailOutput({ Terminal: term.id }, 16_384, at.seq);
  if (!tail) return;
  const text = at.carry + at.decoder.decode(tail.data, { stream: true });
  seen.set(term.id, { seq: tail.end_seq, carry: text.slice(-2048), decoder: at.decoder });
  // Once an address is found it holds for the run: a later URL is usually
  // a request the server logged, not where it moved to.
  const url = getState().runUrls[term.id] ?? findLocalUrl(text);
  if (url && getState().runUrls[term.id] !== url) {
    setState((s) => ({ runUrls: { ...s.runUrls, [term.id]: url } }));
  }
}

/** Mount once: watches the selected project's live run terminals. */
export function useRunWatch() {
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      const s = getState();
      const trees = s.selectedProject ? projectWorktrees(s, s.selectedProject) : [];
      for (const wt of trees) {
        const term = runTerminal(s, wt.id);
        if (!term) continue;
        if (term.alive) void watch(term);
        // Stopped: it isn't served anywhere now.
        else forget(term.id);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);
}

/** The prompt that has an agent work out and record the start command. */
export const SETUP_RUN_PROMPT =
  'Work out how to start this project\'s local dev server: look at package.json scripts, a Makefile, docker-compose, the README, and so on. Write the command as "run" in a .nebula.json at the repository root, for example {"run": "npm run dev"}, keeping any other keys the file already has. Don\'t start the server yourself. If there is nothing to serve, say so instead of writing the file.';
