import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { onExit, onPty, send, sendInput } from "../nebula/client";
import { getState, projectOfWorktree, setState, urgency, useAppState, type State } from "../nebula/store";
import { STATUS_LABEL } from "../nebula/status";
import { terminalTheme } from "./TerminalPane";
import type { Agent } from "../nebula/types";
import { noteTyped } from "../nebula/queue";
import { noteSize } from "../nebula/screen";

export const GRID_MAX = 4;

/** The tasks the grid shows: the open one first, then the selected
 *  project's others by urgency (waiting, working, unread), up to four. */
export function gridAgents(s: State): Agent[] {
  const sel = s.selectedSession;
  const current = sel && "Agent" in sel ? s.agents[sel.Agent] : undefined;
  const inProject = (a: Agent) => s.worktrees[a.worktree_id]?.project_id === s.selectedProject;
  const rest = Object.values(s.agents)
    .filter((a) => !a.archived && a.id !== current?.id && inProject(a))
    .sort((a, b) => urgency(a) - urgency(b) || b.status_changed_at - a.status_changed_at);
  const first = current && !current.archived && inProject(current) ? [current] : [];
  return [...first, ...rest].slice(0, GRID_MAX);
}

/** Up to four agents' terminals at once. Each tile is its own attachment;
 *  typing goes to the tile you clicked (the selected session). */
export function GridView({ onExit: leave }: { onExit: () => void }) {
  const state = useAppState();
  const ids = gridAgents(state).map((a) => a.id);
  // Keep the tiles in place while they exist, so a status change doesn't
  // reshuffle what you're watching; new ones fill free slots.
  const [order, setOrder] = useState<string[]>(ids);
  const key = ids.join(",");
  useEffect(() => {
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      return [...kept, ...added].slice(0, GRID_MAX);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const agents = order.map((id) => state.agents[id]).filter((a): a is Agent => !!a);
  const sel = state.selectedSession;

  return (
    <section className="grid-view" aria-label="Task grid">
      <header className="pane-head grid-head" data-tauri-drag-region>
        <div className="pane-title" data-tauri-drag-region>
          <h2 className="pane-name">Grid</h2>
          <span className="pane-meta">
            <span>
              {agents.length} of the project's tasks, the most urgent first. Click a tile to type into it.
            </span>
          </span>
        </div>
        <div className="pane-actions">
          <button className="btn" onClick={leave} title="Back to one terminal (⌘G)">
            Single view
          </button>
        </div>
      </header>
      {agents.length === 0 ? (
        <div className="pane-empty">
          <p>No tasks in this project to watch.</p>
        </div>
      ) : (
        <div className={`grid-tiles tiles-${agents.length}`}>
          {agents.map((a) => (
            <Tile key={a.id} agent={a} focused={!!sel && "Agent" in sel && sel.Agent === a.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function Tile({ agent, focused }: { agent: Agent; focused: boolean }) {
  const state = useAppState();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [exited, setExited] = useState(false);
  const project = useMemo(() => projectOfWorktree(state, agent.worktree_id), [state, agent.worktree_id]);
  const wt = state.worktrees[agent.worktree_id];
  const connected = state.link.state === "connected";

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme(state.mode);
  }, [state.mode]);

  useEffect(() => {
    if (!host.current || !connected) return;
    const ref = { Agent: agent.id };
    const t = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 11.5,
      lineHeight: 1.1,
      scrollback: 3_000,
      allowProposedApi: true,
      theme: terminalTheme(getState().mode),
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = "11";
    t.open(host.current);
    fit.fit();
    term.current = t;

    t.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
        void sendInput(ref, "\x1b\r");
        return false;
      }
      return true;
    });
    const offData = t.onData((data) => {
      noteTyped(agent.id);
      void sendInput(ref, data);
    });
    const onFocus = () => setState({ selectedSession: ref });
    t.textarea?.addEventListener("focus", onFocus);

    let end = 0;
    const offPty = onPty(ref, (chunk, bytes) => {
      if (chunk.replay) {
        t.reset();
        t.write(bytes);
        end = chunk.seq + bytes.length;
        setExited(false);
        return;
      }
      const stop = chunk.seq + bytes.length;
      if (stop <= end) return;
      t.write(chunk.seq < end ? bytes.subarray(end - chunk.seq) : bytes);
      end = stop;
    });
    const offExit = onExit(ref, () => setExited(true));
    void send("Attach", { session: ref, from_seq: null, cols: t.cols, rows: t.rows });
    noteSize(agent.id, t.cols, t.rows);

    const observer = new ResizeObserver(() => {
      const { cols, rows } = t;
      fit.fit();
      if (t.cols !== cols || t.rows !== rows) {
        void send("Resize", { session: ref, cols: t.cols, rows: t.rows });
        noteSize(agent.id, t.cols, t.rows);
      }
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      offData.dispose();
      t.textarea?.removeEventListener("focus", onFocus);
      offPty();
      offExit();
      void send("Detach", { session: ref }).catch(() => {});
      t.dispose();
      term.current = null;
    };
  }, [agent.id, connected, state.epoch]);

  // The selected tile takes the keyboard, and reading it marks it seen.
  useEffect(() => {
    if (!focused) return;
    term.current?.focus();
    if (agent.unseen) void send("MarkAgentSeen", { id: agent.id });
  }, [focused, agent.unseen, agent.id]);

  return (
    <article className={`gtile-term${focused ? " is-focused" : ""} row-${agent.status}`}>
      <header className="gtile-head" onMouseDown={() => setState({ selectedSession: { Agent: agent.id } })}>
        <span className={`sdot dot-${agent.status}${agent.unseen ? " is-unseen" : ""}`} aria-hidden />
        <span className="gtile-name">{agent.name}</span>
        <span className="gtile-where">
          {project?.name}
          {wt && !wt.is_main ? ` · ${wt.branch}` : ""}
        </span>
        <span className={`pill pill-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
      </header>
      <div className="gtile-body" data-drop-session={`a:${agent.id}`}>
        <div ref={host} className="gtile-xterm" />
        {exited && <div className="gtile-exit">Session ended</div>}
      </div>
    </article>
  );
}
