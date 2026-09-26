import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { debugLog, onExit, onPty, request, send, sendInput } from "../nebula/client";
import { getState, projectOfWorktree, setState, useAppState } from "../nebula/store";
import { agentSpec, STATUS_LABEL } from "../nebula/status";
import { sessionKey, type SessionRef } from "../nebula/types";

const THEME = {
  background: "#0f1524",
  foreground: "#dfe4f0",
  cursor: "#9db4ff",
  cursorAccent: "#0f1524",
  selectionBackground: "#35456f",
  black: "#1b2438",
  red: "#ff7a6b",
  green: "#5fd4b0",
  yellow: "#f2b84b",
  blue: "#7fa2ff",
  magenta: "#c49bff",
  cyan: "#62c7e6",
  white: "#dfe4f0",
  brightBlack: "#5c6682",
  brightRed: "#ff9a8e",
  brightGreen: "#86e3c6",
  brightYellow: "#f7cd7a",
  brightBlue: "#a5bdff",
  brightMagenta: "#d6b8ff",
  brightCyan: "#8ad8ef",
  brightWhite: "#ffffff",
};

/** The terminal on the light surfaces: the same hues, deep enough to read. */
const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1b2233",
  cursor: "#3d5bd9",
  cursorAccent: "#ffffff",
  selectionBackground: "#cdd7f7",
  black: "#1b2233",
  red: "#c23a2b",
  green: "#1f8a67",
  yellow: "#946000",
  blue: "#2f55c9",
  magenta: "#8a44c2",
  cyan: "#10798f",
  white: "#8a93a8",
  brightBlack: "#5c6682",
  brightRed: "#d4442f",
  brightGreen: "#23a079",
  brightYellow: "#a86a00",
  brightBlue: "#3d5bd9",
  brightMagenta: "#9d55d6",
  brightCyan: "#138aa3",
  brightWhite: "#1b2233",
};

const terminalTheme = (mode: string) =>
  mode === "light" ? LIGHT_THEME : mode === "black" ? { ...THEME, background: "#000000", cursorAccent: "#000000" } : THEME;

export function TerminalPane({ onNewTask }: { onNewTask: () => void }) {
  const state = useAppState();
  const session = state.selectedSession;
  const agent = session && "Agent" in session ? state.agents[session.Agent] : undefined;
  const tab = session && "Terminal" in session ? state.terminals[session.Terminal] : undefined;
  const exists = !!(agent || tab);

  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const current = useRef<SessionRef | null>(null);
  const [ready, setReady] = useState(false);
  const [exited, setExited] = useState<number | null | undefined>(undefined);

  // Follow the app's light/dark/black surfaces.
  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme(state.mode);
  }, [state.mode]);

  // One xterm for the app's lifetime; sessions swap in and out of it.
  useEffect(() => {
    let disposed = false;
    const t = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10_000,
      allowProposedApi: true,
      cursorBlink: true,
      theme: terminalTheme(getState().mode),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = "11";

    // Shift+Enter is a newline in Claude Code and friends: send ESC CR
    // (what their terminal setup maps it to) instead of a bare CR.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
        if (current.current) void sendInput(current.current, "\x1b\r");
        return false;
      }
      return true;
    });
    t.onData((data) => {
      if (current.current) void sendInput(current.current, data);
    });

    document.fonts.load('13px "JetBrains Mono"').finally(() => {
      if (disposed || !host.current) return;
      t.open(host.current);
      // WebGL in the app; the browser preview keeps the DOM renderer, which
      // survives page zoom and is readable in devtools.
      if ("__TAURI_INTERNALS__" in window) {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          t.loadAddon(webgl);
        } catch {
          // The DOM renderer is slower but fine.
        }
      }
      f.fit();
      term.current = t;
      fit.current = f;
      if (import.meta.env.DEV) (window as unknown as { __term: Terminal }).__term = t;
      setReady(true);
    });

    const observer = new ResizeObserver(() => {
      if (!term.current || !fit.current) return;
      const { cols, rows } = term.current;
      fit.current.fit();
      const t2 = term.current;
      if (current.current && (t2.cols !== cols || t2.rows !== rows)) {
        void send("Resize", { session: current.current, cols: t2.cols, rows: t2.rows });
      }
    });
    if (host.current) observer.observe(host.current);

    return () => {
      disposed = true;
      observer.disconnect();
      t.dispose();
      term.current = null;
    };
  }, []);

  // Attach the selected session; re-attach after a reconnect (epoch).
  const key = session && exists ? sessionKey(session) : null;
  const connected = state.link.state === "connected";
  useEffect(() => {
    const t = term.current;
    if (!ready || !t || !session || !key || !connected) return;
    const ref = session;
    current.current = ref;
    setExited(undefined);
    t.reset();
    fit.current?.fit();

    // `end` is the seq just past the last byte written, so replayed and
    // live output that overlap are written once.
    let end = 0;
    const offPty = onPty(ref, (chunk, bytes) => {
      if (chunk.replay) {
        t.reset();
        t.write(bytes);
        end = chunk.seq + bytes.length;
        debugLog(`replay ${key}: ${bytes.length} bytes at ${t.cols}x${t.rows}`);
        return;
      }
      const stop = chunk.seq + bytes.length;
      if (stop <= end) return;
      t.write(chunk.seq < end ? bytes.subarray(end - chunk.seq) : bytes);
      end = stop;
    });
    const offExit = onExit(ref, (code) => setExited(code));

    void send("Attach", { session: ref, from_seq: null, cols: t.cols, rows: t.rows });
    if ("Agent" in ref) void send("MarkAgentSeen", { id: ref.Agent });
    t.focus();

    return () => {
      offPty();
      offExit();
      current.current = null;
      void send("Detach", { session: ref }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key, connected, state.epoch]);

  // Looking at a session whose turn just finished marks it read.
  useEffect(() => {
    if (agent?.unseen && document.hasFocus()) void send("MarkAgentSeen", { id: agent.id });
  }, [agent?.unseen, agent?.id]);

  const project = agent || tab ? projectOfWorktree(state, (agent ?? tab)!.worktree_id) : undefined;
  const wt = agent || tab ? state.worktrees[(agent ?? tab)!.worktree_id] : undefined;

  return (
    <section className="pane" aria-label="Terminal">
      {exists ? (
        <header className="pane-head" data-tauri-drag-region>
          <div className="pane-title" data-tauri-drag-region>
            {agent && <span className={`sdot dot-${agent.status}`} aria-hidden />}
            <RenameableTitle
              key={agent?.id ?? tab?.id}
              name={(agent ?? tab)!.name}
              onRename={(name) =>
                agent
                  ? request("RenameAgent", { id: agent.id, name })
                  : request("RenameTerminal", { id: tab!.id, name })
              }
            />
            <span className="pane-meta">
              {agent && <span className={`pill pill-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>}
              <span>{agent ? agentSpec(agent) : "Shell"}</span>
              {project && (
                <span>
                  {project.name}
                  {wt && !wt.is_main ? ` on ${wt.branch}` : ""}
                </span>
              )}
            </span>
          </div>
          <div className="pane-actions">
            {agent && !agent.archived && (
              <>
                <button className="btn" onClick={() => request("RestartAgent", { id: agent.id })}>
                  Restart
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    void request("ArchiveAgent", { id: agent.id });
                    setState({ selectedSession: null });
                  }}
                >
                  Archive
                </button>
              </>
            )}
            {agent?.archived && (
              <button className="btn" onClick={() => request("UnarchiveAgent", { id: agent.id })}>
                Restore
              </button>
            )}
            {tab && (
              <button
                className="btn"
                onClick={() => {
                  void request("CloseTerminal", { id: tab.id });
                  setState({ selectedSession: null });
                }}
              >
                Close shell
              </button>
            )}
          </div>
        </header>
      ) : (
        <header className="pane-head" data-tauri-drag-region />
      )}

      <div className="pane-body">
        <div ref={host} className={`xterm-host${exists ? "" : " is-hidden"}`} />
        {!exists && (
          <div className="pane-empty">
            <p>Open a session from the list, or start something new.</p>
            <button className="btn btn-primary" onClick={onNewTask}>
              New task
            </button>
          </div>
        )}
        {exists && exited !== undefined && (
          <div className="pane-exit">
            <span>
              {exited === 0 || exited === null
                ? "This session has ended."
                : `This session exited with code ${exited}.`}
            </span>
            {agent && (
              <button className="btn" onClick={() => request("RestartAgent", { id: agent.id })}>
                Resume session
              </button>
            )}
          </div>
        )}
        {exists && !connected && (
          <div className="pane-exit">
            <span>Reconnecting to the daemon…</span>
          </div>
        )}
      </div>
    </section>
  );
}

function RenameableTitle({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (!editing) {
    return (
      <h2 className="pane-name" onDoubleClick={() => (setDraft(name), setEditing(true))} title="Double-click to rename">
        {name}
      </h2>
    );
  }
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== name) void onRename(next).catch((e) => console.warn(e));
  };
  return (
    <input
      className="pane-name-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      aria-label="Session name"
    />
  );
}
