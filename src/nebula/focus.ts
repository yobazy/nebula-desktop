// Switching projects brings up a session of that project: the one you last
// had open there, else the one most recently active. Remembered per project
// across launches, since which session you were looking at is known only to
// this app.
import { useEffect } from "react";
import { getState, setState, subscribe, type State } from "./store";
import { sameSession, type SessionRef } from "./types";

const KEY = "nebula-desktop.lastSessions";

function load(): Record<string, SessionRef> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

function save(last: Record<string, SessionRef>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(last));
  } catch {
    // A convenience: without storage it lasts until the app quits.
  }
}

/** The project a session belongs to, if it still exists. */
export function projectOfSession(s: State, ref: SessionRef): string | null {
  const worktree =
    "Agent" in ref ? s.agents[ref.Agent]?.worktree_id : s.terminals[ref.Terminal]?.worktree_id;
  return (worktree && s.worktrees[worktree]?.project_id) || null;
}

/** What to show on arriving in `projectId`: the session last open there if
 *  it's still around, else the live agent whose status changed last, else
 *  a terminal, else nothing. */
export function sessionFor(s: State, projectId: string, last: Record<string, SessionRef>): SessionRef | null {
  const remembered = last[projectId];
  if (remembered && projectOfSession(s, remembered) === projectId) {
    const archived = "Agent" in remembered && s.agents[remembered.Agent]?.archived;
    if (!archived) return remembered;
  }
  const inProject = (worktreeId: string) => s.worktrees[worktreeId]?.project_id === projectId;
  const agent = Object.values(s.agents)
    .filter((a) => !a.archived && inProject(a.worktree_id))
    .sort((a, b) => b.status_changed_at - a.status_changed_at)[0];
  if (agent) return { Agent: agent.id };
  const term = Object.values(s.terminals).find((t) => inProject(t.worktree_id));
  return term ? { Terminal: term.id } : null;
}

/** Mount once. */
export function useProjectSessions() {
  useEffect(() => {
    const last = load();
    let { selectedProject, selectedSession } = getState();

    const check = () => {
      const s = getState();
      if (s.selectedSession !== selectedSession && s.selectedSession) {
        const project = projectOfSession(s, s.selectedSession);
        if (project && !sameSession(last[project] ?? null, s.selectedSession)) {
          last[project] = s.selectedSession;
          save(last);
        }
      }
      const projectChanged = s.selectedProject !== selectedProject;
      selectedProject = s.selectedProject;
      selectedSession = s.selectedSession;
      // Picking a session elsewhere (the waiting list, ⌘J, a usage row)
      // sets its project too, so only a session from another project — or
      // none — is replaced.
      if (!projectChanged || !s.selectedProject || !s.loaded) return;
      const current = s.selectedSession && projectOfSession(s, s.selectedSession);
      if (current === s.selectedProject) return;
      const next = sessionFor(s, s.selectedProject, last);
      if (!sameSession(next, s.selectedSession)) setState({ selectedSession: next });
    };
    return subscribe(check);
  }, []);
}
