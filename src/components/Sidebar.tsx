import { useMemo, useRef, useState, useEffect } from "react";
import {
  STATUS_ORDER,
  projectAgents,
  projectOfWorktree,
  setState,
  sortedProjects,
  useAppState,
  waitingAgents,
} from "../nebula/store";
import { relativeTime } from "../nebula/status";
import type { Agent, Project } from "../nebula/types";
import { UsageChip } from "./Usage";
import { Pet } from "./Pet";

export function selectAgent(agent: Agent) {
  setState((s) => ({
    selectedProject: s.worktrees[agent.worktree_id]?.project_id ?? s.selectedProject,
    selectedSession: { Agent: agent.id },
  }));
}

export function Sidebar({ onAddProject, onHide }: { onAddProject: () => void; onHide: () => void }) {
  const state = useAppState();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const projects = useMemo(() => sortedProjects(state), [state]);
  const waiting = useMemo(() => waitingAgents(state), [state]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? projects.filter(
          (p) => p.name.toLowerCase().includes(q) || p.repo_path.toLowerCase().includes(q),
        )
      : projects;
  }, [projects, query]);

  // ⌘P jumps to the project filter; ⌘1–9 picks a project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "p") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (/^[1-9]$/.test(e.key)) {
        const p = projects[Number(e.key) - 1];
        if (p) {
          e.preventDefault();
          setState({ selectedProject: p.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projects]);

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="sidebar-top" data-tauri-drag-region>
        <span className="wordmark" data-tauri-drag-region>
          nebula
        </span>
        <span className="sidebar-actions">
          <LinkDot />
          <button className="icon-btn" title="Hide projects (⌘B)" aria-label="Hide projects" onClick={onHide}>
            <PanelGlyph />
          </button>
          <button
            className="icon-btn"
            title="Add project (⌘O)"
            aria-label="Add project"
            onClick={onAddProject}
          >
            +
          </button>
        </span>
      </div>

      {waiting.length > 0 && (
        <section className="waiting" aria-label="Sessions waiting on you">
          <h2 className="waiting-title">
            Waiting on you <span className="waiting-count">{waiting.length}</span>
          </h2>
          <ul>
            {waiting.map((a) => (
              <li key={a.id}>
                <button className="waiting-row" onClick={() => selectAgent(a)}>
                  <span className="sdot dot-needs_feedback" aria-hidden />
                  <span className="waiting-name">{a.name}</span>
                  <span className="waiting-where">
                    {projectOfWorktree(state, a.worktree_id)?.name}
                    <span className="waiting-age">{relativeTime(a.status_changed_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="project-search">
        <input
          ref={search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) {
              setState({ selectedProject: shown[0].id });
              setQuery("");
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
          }}
          placeholder={`Filter ${projects.length} projects`}
          aria-label="Filter projects"
          spellCheck={false}
        />
        <kbd>⌘P</kbd>
      </div>

      <ul className="project-list">
        {shown.map((p, i) => (
          <li key={p.id}>
            <ProjectRow
              project={p}
              index={query ? null : i}
              agents={projectAgents(state, p.id)}
              live={Object.values(state.terminals).some(
                (t) => t.alive && t.run_command !== null && state.worktrees[t.worktree_id]?.project_id === p.id,
              )}
              selected={p.id === state.selectedProject}
            />
          </li>
        ))}
        {shown.length === 0 && state.loaded && (
          <li className="project-empty">
            {query ? (
              `No project matches “${query}”.`
            ) : (
              <>
                <p>No projects yet.</p>
                <button className="btn" onClick={onAddProject}>
                  Add a project <kbd>⌘O</kbd>
                </button>
              </>
            )}
          </li>
        )}
      </ul>

      <Pet on={state.prefs.pet !== false} />
      <footer className="sidebar-foot">
        <UsageChip />
        <button
          className={`icon-btn foot-gear${state.view === "settings" ? " is-on" : ""}`}
          onClick={() => setState({ view: state.view === "settings" ? "sessions" : "settings" })}
          aria-pressed={state.view === "settings"}
          aria-label="Settings"
          title="Settings (⌘,)"
        >
          <GearGlyph />
        </button>
      </footer>
    </nav>
  );
}

function ProjectRow({
  project,
  index,
  agents,
  selected,
  live,
}: {
  project: Project;
  index: number | null;
  agents: Agent[];
  selected: boolean;
  live: boolean;
}) {
  const needs = agents.filter((a) => a.status === "needs_feedback").length;
  const unseen = agents.filter((a) => a.status === "finished" && a.unseen).length;
  const running = agents.filter((a) => a.status === "running").length;
  const ordered = [...agents].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  const summary = [
    needs && `${needs} waiting`,
    running && `${running} working`,
    unseen && `${unseen} unread`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <button
      className={`project-row${selected ? " is-selected" : ""}`}
      onClick={() => setState({ selectedProject: project.id })}
      aria-current={selected ? "page" : undefined}
      title={project.repo_path}
    >
      <span className="project-line">
        <span className="project-name">{project.name}</span>
        {live && <span className="live-dot" title="Dev server running" aria-label="Dev server running" />}
        <span className="project-meta">
          {running > 0 && (
            <span className="project-working" title={`${running} in progress`}>
              <span className="orbit" aria-hidden />
              <span className="sr-only">{running} in progress</span>
              <span aria-hidden>{running}</span>
            </span>
          )}
          {needs > 0 && (
            <span className="project-badge badge-needs" title={`${needs} waiting on you`}>
              {needs}
            </span>
          )}
          {unseen > 0 && (
            <span className="project-badge badge-unseen" title={`${unseen} finished, unread`}>
              {unseen}
            </span>
          )}
          {running + needs + unseen === 0 && index !== null && index < 9 && (
            <kbd className="project-key">⌘{index + 1}</kbd>
          )}
        </span>
      </span>
      {/* One segment per live session, ordered by urgency. */}
      <span className="spectrum" aria-label={summary || `${agents.length} sessions`}>
        {ordered.length === 0 ? (
          <span className="spectrum-empty" />
        ) : (
          ordered.map((a) => (
            <span key={a.id} className={`seg seg-${a.status}${a.unseen ? " is-unseen" : ""}`} />
          ))
        )}
      </span>
    </button>
  );
}

function LinkDot() {
  const link = useAppState().link;
  const label =
    link.state === "connected"
      ? `Connected to daemon (pid ${link.daemonPid})`
      : link.state === "connecting"
        ? "Connecting to daemon"
        : "Daemon not connected";
  return <span className={`link-dot link-${link.state}`} title={label} aria-label={label} />;
}

function GearGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Zm5.3 3.3.9.7-1.1 2-1.1-.3a4.8 4.8 0 0 1-1.3.8l-.2 1.1H7.5l-.2-1.1a4.8 4.8 0 0 1-1.3-.8l-1.1.3-1.1-2 .9-.7a4.9 4.9 0 0 1 0-1.8l-.9-.7 1.1-2 1.1.3c.4-.3.8-.6 1.3-.8l.2-1.1h2.2l.2 1.1c.5.2.9.5 1.3.8l1.1-.3 1.1 2-.9.7a4.9 4.9 0 0 1 0 1.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A window with its left panel marked: hide or show a column. */
export function PanelGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
