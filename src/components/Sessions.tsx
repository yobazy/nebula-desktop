import { useEffect, useMemo, useState } from "react";
import {
  flash,
  projectWorktrees,
  setState,
  useAppState,
  worktreeAgents,
  worktreeTerminals,
} from "../nebula/store";
import { agentSpec, lastPrompt, relativeTime, STATUS_LABEL } from "../nebula/status";
import { request } from "../nebula/client";
import { changedFiles, neverPushed, shipKind, type GitState, type GitStatus } from "../nebula/git";
import { runOnWorktree, SHIP_LABEL, shipPrompt, shipWhat, takerFor } from "../nebula/actions";
import { BandRunButton, BandRunLine, ProjectRun } from "./Run";
import { useRowMenu, type Seed } from "./RowMenu";
import { PanelGlyph } from "./Sidebar";
import { sameSession, type Agent, type TerminalTab, type Worktree } from "../nebula/types";

/** Re-render once a minute so relative times stay honest. */
function useMinuteTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}

type NewTask = (worktree?: string, seed?: Seed) => void;

export function Sessions({ onNewTask, onHide }: { onNewTask: NewTask; onHide: () => void }) {
  const state = useAppState();
  useMinuteTick();
  const rowMenu = useRowMenu(onNewTask);
  const project = state.selectedProject ? state.projects[state.selectedProject] : undefined;
  const worktrees = useMemo(
    () => (project ? projectWorktrees(state, project.id) : []),
    [state, project],
  );

  if (!project) {
    return (
      <section className="sessions sessions-empty">
        <p>{state.loaded ? "Pick a project on the left." : "Loading projects…"}</p>
      </section>
    );
  }

  return (
    <section className="sessions" aria-label={`${project.name} sessions`}>
      <header className="sessions-head" data-tauri-drag-region>
        <div className="sessions-title" data-tauri-drag-region>
          <h1>{project.name}</h1>
          <p className="sessions-path" title={project.repo_path}>
            {project.repo_path.replace(/^\/Users\/[^/]+/, "~")}
          </p>
        </div>
        <div className="sessions-actions">
          <button className="icon-btn" title="Hide tasks (⌥⌘B)" aria-label="Hide tasks" onClick={onHide}>
            <PanelGlyph />
          </button>
          {worktrees[0]?.is_main && <ProjectRun worktree={worktrees[0]} />}
          <button className="btn btn-primary" onClick={() => onNewTask()} title="New task (⌘N)">
            New task
          </button>
        </div>
      </header>

      <div className="bands">
        {worktrees.map((wt) => (
          <Band key={wt.id} worktree={wt} onNewTask={onNewTask} onMenu={rowMenu.openFor} />
        ))}
      </div>
      {rowMenu.element}
    </section>
  );
}

type OpenMenu = ReturnType<typeof useRowMenu>["openFor"];

function Band({
  worktree,
  onNewTask,
  onMenu,
}: {
  worktree: Worktree;
  onNewTask: NewTask;
  onMenu: OpenMenu;
}) {
  const state = useAppState();
  const [showArchived, setShowArchived] = useState(false);
  const agents = worktreeAgents(state, worktree.id);
  const archived = worktreeAgents(state, worktree.id, true);
  const terminals = worktreeTerminals(state, worktree.id);
  const git = state.git[worktree.id];

  return (
    <section className="band">
      <header className="band-head">
        <span className="band-branch" title={worktree.path}>
          <BranchGlyph />
          {worktree.branch}
        </span>
        {worktree.is_main && <span className="band-note">main checkout</span>}
        <span className="band-actions">
          {git && !("error" in git) && <ShipButton worktree={worktree} git={git} />}
          {!worktree.is_main && <BandRunButton worktree={worktree} />}
          <button
            className="icon-btn"
            title="New shell in this checkout"
            aria-label={`New shell in ${worktree.branch}`}
            onClick={() =>
              request("CreateTerminal", { worktree: worktree.id, name: null }).then((c) => {
                if (c && "Terminal" in c) setState({ selectedSession: { Terminal: c.Terminal } });
              })
            }
          >
            <ShellGlyph />
          </button>
          <button
            className="icon-btn"
            title={`New task on ${worktree.branch}`}
            aria-label={`New task on ${worktree.branch}`}
            onClick={() => onNewTask(worktree.id)}
          >
            +
          </button>
        </span>
      </header>
      {git && <GitLine git={git} worktree={worktree} />}
      <BandRunLine worktree={worktree} />

      <ul className="rows">
        {agents.map((a) => (
          <li key={a.id}>
            <AgentRow agent={a} onMenu={onMenu} />
          </li>
        ))}
        {terminals.map((t) => (
          <li key={t.id}>
            <TerminalRow tab={t} onMenu={onMenu} />
          </li>
        ))}
        {agents.length === 0 && terminals.length === 0 && (
          <li className="rows-empty">
            <button className="link-btn" onClick={() => onNewTask(worktree.id)}>
              Start a task on this branch
            </button>
          </li>
        )}
      </ul>

      {archived.length > 0 && (
        <>
          <button className="archived-toggle" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide" : "Show"} {archived.length} archived
          </button>
          {showArchived && (
            <ul className="rows rows-archived">
              {archived.map((a) => (
                <li key={a.id}>
                  <AgentRow agent={a} onMenu={onMenu} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Where the branch's code stands, in the order it matters: conflicts, then
 *  uncommitted work, then commits that aren't on the remote yet. */
function GitLine({ git, worktree }: { git: GitState; worktree: Worktree }) {
  if ("error" in git) {
    return (
      <p className="git-line" title={git.error}>
        <span className="git-muted">git: {git.error.split("\n")[0]}</span>
      </p>
    );
  }
  const files = changedFiles(git);
  const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;
  const parts: React.ReactNode[] = [];
  if (!git.branch) parts.push(<span className="git-muted">Detached HEAD</span>);
  if (git.conflicted > 0) parts.push(<span className="git-warn">{git.conflicted} in conflict</span>);
  if (files > 0)
    parts.push(
      <span title={`${git.staged} staged, ${git.unstaged} modified, ${git.untracked} untracked`}>
        {files} {files === 1 ? "file" : "files"} changed
        {(git.insertions > 0 || git.deletions > 0) && (
          <>
            {" "}
            <span className="git-add" aria-hidden>
              +{git.insertions}
            </span>{" "}
            <span className="git-del" aria-hidden>
              −{git.deletions}
            </span>
            <span className="sr-only">
              , {git.insertions} lines added, {git.deletions} removed
            </span>
          </>
        )}
      </span>,
    );
  if (git.ahead > 0 && !git.upstreamGone)
    parts.push(
      <span className="git-push">
        <span aria-hidden>↑{git.ahead} to push</span>
        <span className="sr-only">{commits(git.ahead)} to push</span>
      </span>,
    );
  if (neverPushed(git, worktree))
    parts.push(<span className="git-push">{commits(git.baseAhead ?? 0)}, never pushed</span>);
  if (git.upstreamGone)
    parts.push(
      <span className="git-muted" title={`${git.upstream} no longer exists on the remote`}>
        Remote branch deleted, merged?
      </span>,
    );
  if (git.behind > 0 && !git.upstreamGone)
    parts.push(
      <span title={`${git.upstream} has commits this branch lacks`}>
        <span aria-hidden>↓{git.behind} behind</span>
        <span className="sr-only">
          {commits(git.behind)} behind {git.upstream}
        </span>
      </span>,
    );
  if (parts.length === 0)
    parts.push(<span className="git-muted">{git.upstream ? "Clean, pushed" : "Clean"}</span>);

  return (
    <p className="git-line">
      {parts.map((p, i) => (
        <span key={i} className="git-part">
          {p}
        </span>
      ))}
      {git.lastCommit && (
        <span className="git-last" title={git.lastCommit.subject}>
          {git.lastCommit.subject}
          <span className="git-age">{relativeTime(git.lastCommit.time * 1000)}</span>
        </span>
      )}
    </p>
  );
}

/** One click to get a branch shipped, by an agent on it. */
function ShipButton({ worktree, git }: { worktree: Worktree; git: GitStatus }) {
  const state = useAppState();
  const [sending, setSending] = useState(false);
  const kind = shipKind(git, worktree);
  if (!kind || !git.branch) return null;
  const branch = git.branch;
  const taker = takerFor(state, worktree.id);
  // On the main checkout the push lands straight on main: say so.
  const label = worktree.is_main && kind !== "resolve" ? `${SHIP_LABEL[kind]} ${branch}` : SHIP_LABEL[kind];
  const blocked = taker.kind === "busy" || sending;
  const why =
    taker.kind === "busy"
      ? taker.agent.status === "fresh"
        ? `${taker.agent.name} is still starting up`
        : `${taker.agent.name} is still working on this branch`
      : taker.kind === "agent"
        ? `Ask ${taker.agent.name} to ${shipWhat(kind, branch)}`
        : `Start an agent to ${shipWhat(kind, branch)}`;

  return (
    <>
      <button
        className={`btn btn-sm btn-ship${kind === "resolve" ? " is-resolve" : ""}`}
        aria-disabled={blocked}
        aria-label={`${SHIP_LABEL[kind]} ${branch}. ${why}`}
        title={why}
        onClick={async () => {
          if (blocked) {
            flash(why);
            return;
          }
          setSending(true);
          try {
            await runOnWorktree(worktree.id, shipPrompt(kind, git), shipWhat(kind, branch));
          } catch (e) {
            flash(e instanceof Error ? e.message : String(e));
          } finally {
            // The agent takes a moment to report it's running; don't double-send.
            setTimeout(() => setSending(false), 2500);
          }
        }}
      >
        <UpGlyph />
        {sending ? "Sending…" : label}
      </button>
      <span className="sr-only" aria-live="polite">
        {sending ? `Sending to ${taker.kind === "agent" ? taker.agent.name : "a new agent"}` : ""}
      </span>
    </>
  );
}

function AgentRow({ agent, onMenu }: { agent: Agent; onMenu: OpenMenu }) {
  const selected = sameSession(useAppState().selectedSession, { Agent: agent.id });
  const prompt = lastPrompt(agent);
  return (
    <button
      className={`row row-${agent.status}${selected ? " is-selected" : ""}${agent.unseen ? " is-unseen" : ""}`}
      onClick={() => setState({ selectedSession: { Agent: agent.id } })}
      onContextMenu={(e) => onMenu(e, { Agent: agent })}
      aria-current={selected ? "true" : undefined}
    >
      <span
        className={`sdot dot-${agent.status}${agent.unseen ? " is-unseen" : ""}`}
        title={STATUS_LABEL[agent.status]}
        aria-label={STATUS_LABEL[agent.status]}
      />
      <span className="row-main">
        <span className="row-name">{agent.name}</span>
        <span className="row-prompt">{prompt ?? agentSpec(agent)}</span>
      </span>
      <span className="row-age">{relativeTime(agent.status_changed_at)}</span>
    </button>
  );
}

function TerminalRow({ tab, onMenu }: { tab: TerminalTab; onMenu: OpenMenu }) {
  const selected = sameSession(useAppState().selectedSession, { Terminal: tab.id });
  return (
    <button
      className={`row row-terminal${selected ? " is-selected" : ""}`}
      onClick={() => setState({ selectedSession: { Terminal: tab.id } })}
      onContextMenu={(e) => onMenu(e, { Terminal: tab })}
    >
      <span className="row-glyph" aria-hidden>
        <ShellGlyph />
      </span>
      <span className="row-main">
        <span className="row-name">{tab.name}</span>
        <span className="row-prompt">
          {tab.run_command ?? (tab.alive ? "Shell" : "Shell, not running")}
        </span>
      </span>
    </button>
  );
}

function BranchGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M5 3.25a1.75 1.75 0 1 1-2.5 1.58v6.34a1.75 1.75 0 1 1 1.5 0V9.5c0-1.38 1.12-2.5 2.5-2.5h2A1.5 1.5 0 0 0 10 5.5v-.67a1.75 1.75 0 1 1 1.5 0v.67a3 3 0 0 1-3 3h-2A1 1 0 0 0 5.5 9.5v1.67A1.75 1.75 0 0 1 5 3.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

function UpGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 13V3.5M3.5 8 8 3.5 12.5 8"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShellGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path
        d="m3 4.5 3.5 3.5L3 11.5M8.5 12H13"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
