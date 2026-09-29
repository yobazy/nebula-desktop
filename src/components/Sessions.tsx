import { useEffect, useMemo, useState } from "react";
import {
  flash,
  getState,
  projectWorktrees,
  setState,
  useAppState,
  worktreeAgents,
  worktreeTerminals,
} from "../nebula/store";
import { agentSpec, lastPrompt, relativeTime, statusLabel } from "../nebula/status";
import { request } from "../nebula/client";
import { changedFiles, neverPushed, shipKind, type GitState, type GitStatus } from "../nebula/git";
import { runOnWorktree, SHIP_LABEL, shipPrompt, shipWhat, takerFor } from "../nebula/actions";
import { BandRunButton, BandRunLine, ProjectRun } from "./Run";
import { PrLine } from "./Pr";
import { useHoverPreview } from "./HoverPreview";
import { fanOutOf, openCompare } from "../nebula/fanout";
import { useSessionCosts } from "../nebula/budget";
import { money } from "../nebula/usage";
import { EditorButton } from "./Editor";
import { openReview } from "../nebula/diff";
import { useRowMenu, type Seed } from "./RowMenu";
import { PanelGlyph } from "./Sidebar";
import { ProjectIcon, useProjectColorStyle } from "./ProjectIcon";
import { sameSession, type Agent, type TerminalTab, type Worktree } from "../nebula/types";
import { isFollowUp, isPinned, moveTask, toggleFlag } from "../nebula/organize";
import { FlagGlyph, PinGlyph, useTaskColorStyle } from "./Organize";
import { reorderKey, useReorder } from "./useReorder";

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
  const preview = useHoverPreview();
  const colorStyle = useProjectColorStyle(state.selectedProject ? state.projects[state.selectedProject] : undefined);
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
    <section
      className={`sessions${colorStyle ? " has-color" : ""}`}
      style={colorStyle}
      aria-label={`${project.name} sessions`}
    >
      <header className="sessions-head" data-tauri-drag-region>
        <div className="sessions-title" data-tauri-drag-region>
          <h1>
            <ProjectIcon project={project} size={22} />
            {project.name}
          </h1>
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

      <div className="bands" onMouseOver={preview.onMouseOver} onMouseLeave={preview.onMouseLeave}>
        {worktrees.map((wt) => (
          <Band key={wt.id} worktree={wt} onNewTask={onNewTask} onMenu={rowMenu.openFor} />
        ))}
      </div>
      {rowMenu.element}
      {preview.element}
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
  const reorder = useReorder((id, to, seen) => {
    const a = getState().agents[id];
    if (a) void moveTask(a, to, seen);
  });
  // Mid-drag, rows keep the order the drag began with.
  const sorted = worktreeAgents(state, worktree.id);
  const agents = reorder.frozen
    ? [...sorted].sort((a, b) => rank(reorder.frozen!, a.id) - rank(reorder.frozen!, b.id))
    : sorted;
  const archived = worktreeAgents(state, worktree.id, true);
  const terminals = worktreeTerminals(state, worktree.id);
  // Picking an archived task elsewhere (the follow-up list) shows it here;
  // archiving the open one leaves the list as it was.
  const selectedId = state.selectedSession && "Agent" in state.selectedSession ? state.selectedSession.Agent : null;
  const selectedArchived = archived.some((a) => a.id === selectedId);
  useEffect(() => {
    if (selectedArchived) setShowArchived(true);
    // Only on a pick (each makes a new selection, even of the same task),
    // not when the open task becomes archived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedSession]);
  const git = state.git[worktree.id];

  return (
    <section className="band">
      <header className="band-head">
        <span className="band-title">
          <span className="band-branch" title={worktree.path}>
            <BranchGlyph />
            <span className="band-branch-name" dir="auto">{worktree.branch}</span>
          </span>
          {worktree.is_main && <span className="band-note">main checkout</span>}
          <CompareLink worktreeId={worktree.id} />
          <BandCost worktreeId={worktree.id} />
        </span>
        <span className="band-actions">
          {git && !("error" in git) && <ShipButton worktree={worktree} git={git} />}
          {!worktree.is_main && <BandRunButton worktree={worktree} />}
          <EditorButton worktree={worktree} />
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
      {git && !("error" in git) && <PrLine worktree={worktree} git={git} />}
      <BandRunLine worktree={worktree} />

      <ul className="rows" ref={reorder.list}>
        {agents.map((a, i) => (
          <li key={a.id} {...reorder.item(a.id)}>
            <AgentRow
              agent={a}
              onMenu={onMenu}
              onKeyDown={(e) => reorderKey(e, i, agents.length, (to) => void moveTask(a, to))}
            />
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

/** Where `id` stands in `ids`; those missing go last. */
function rank(ids: string[], id: string): number {
  const i = ids.indexOf(id);
  return i < 0 ? ids.length : i;
}

/** What this branch's tasks have cost (30 days), from Claude Code's logs. */
function BandCost({ worktreeId }: { worktreeId: string }) {
  const state = useAppState();
  const costs = useSessionCosts();
  let total = 0;
  for (const a of Object.values(state.agents)) {
    if (a.worktree_id === worktreeId && a.session_id) total += costs.get(a.session_id) ?? 0;
  }
  if (total < 0.01) return null;
  return (
    <span className="band-cost" title="What this branch's Claude tasks have cost in the last 30 days, at API rates">
      {money(total)}
    </span>
  );
}

/** A fanned-out attempt links to the comparison of its group. */
function CompareLink({ worktreeId }: { worktreeId: string }) {
  const state = useAppState();
  const group = fanOutOf(state, worktreeId);
  if (!group) return null;
  const n = group.worktrees.filter((id) => state.worktrees[id]).length;
  return (
    <button className="band-compare" onClick={() => openCompare(group.id)} title={`One of ${n} attempts at: ${group.prompt}`}>
      1 of {n} · Compare
    </button>
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
  const reviewable = files > 0 || (!worktree.is_main && (git.baseAhead ?? 0) > 0);
  if (reviewable)
    parts.push(
      <button
        className="link-btn git-review"
        onClick={() => openReview(worktree.id)}
        title={files > 0 ? "Review the uncommitted changes" : "Review what this branch changed"}
      >
        Review
      </button>,
    );

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
export function ShipButton({ worktree, git }: { worktree: Worktree; git: GitStatus }) {
  const state = useAppState();
  const [sending, setSending] = useState(false);
  const kind = shipKind(git, worktree);
  if (!kind || !git.branch) return null;
  const branch = git.branch;
  const taker = takerFor(state, worktree.id);
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
        {sending ? "Sending…" : SHIP_LABEL[kind]}
      </button>
      <span className="sr-only" aria-live="polite">
        {sending ? `Sending to ${taker.kind === "agent" ? taker.agent.name : "a new agent"}` : ""}
      </span>
    </>
  );
}

function AgentRow({
  agent,
  onMenu,
  onKeyDown,
}: {
  agent: Agent;
  onMenu: OpenMenu;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const state = useAppState();
  const selected = sameSession(state.selectedSession, { Agent: agent.id });
  const prompt = lastPrompt(agent);
  const pinned = !agent.archived && isPinned(state, agent);
  const flagged = isFollowUp(state, agent.id);
  const colorStyle = useTaskColorStyle(agent);
  return (
    <button
      className={`row row-${agent.status}${selected ? " is-selected" : ""}${agent.unseen ? " is-unseen" : ""}${colorStyle ? " has-color" : ""}`}
      data-agent={agent.id}
      style={colorStyle}
      onClick={() => setState({ selectedSession: { Agent: agent.id } })}
      onContextMenu={(e) => onMenu(e, { Agent: agent })}
      onKeyDown={(e) => {
        // F flags the task to come back to, or clears the flag.
        if (e.key === "f" && e.target === e.currentTarget && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          void toggleFlag(agent);
        } else onKeyDown?.(e);
      }}
      aria-current={selected ? "true" : undefined}
      aria-keyshortcuts={agent.archived ? "F" : "F Alt+ArrowUp Alt+ArrowDown"}
    >
      <span
        className={`sdot dot-${agent.status}${agent.unseen ? " is-unseen" : ""}`}
        title={statusLabel(agent)}
        aria-label={statusLabel(agent)}
      />
      <span className="row-main">
        <span className="row-name">{agent.name}</span>
        <span className="row-prompt">{prompt ?? agentSpec(agent)}</span>
      </span>
      <span className="row-age">
        {flagged && (
          <span className="row-mark mark-flag" role="img" title="Flagged for follow-up (F)" aria-label="Flagged for follow-up">
            <FlagGlyph />
          </span>
        )}
        {pinned && (
          <span className="row-mark" role="img" title="Pinned: stays where you put it. Unpin from its menu." aria-label="Pinned">
            <PinGlyph />
          </span>
        )}
        {relativeTime(agent.status_changed_at)}
      </span>
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
