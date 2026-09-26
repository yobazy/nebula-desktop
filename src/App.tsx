import { useCallback, useEffect, useState } from "react";
import { Sidebar, selectAgent } from "./components/Sidebar";
import { Sessions } from "./components/Sessions";
import { TerminalPane } from "./components/TerminalPane";
import { LaunchDialog } from "./components/LaunchDialog";
import { DaemonGate } from "./components/DaemonGate";
import { AddProjectDialog, Notice, addProject, type AddStep } from "./components/AddProject";
import { start } from "./nebula/client";
import { useGitPolling } from "./nebula/git";
import { fitColumns, Resizer, SESSIONS, SIDEBAR, useColumnWidth, useWindowWidth } from "./components/Resizer";
import { UsageView } from "./components/Usage";
import { SettingsView } from "./components/Settings";
import { useUsagePolling } from "./nebula/usage";
import { useTheme } from "./nebula/theme";
import { useRunWatch } from "./nebula/runs";
import { useProjectSessions } from "./nebula/focus";
import { getState, setState, subscribe, useAppState, waitingAgents } from "./nebula/store";

export default function App() {
  const [launch, setLaunch] = useState<{ worktree: string | null } | null>(null);
  const openLaunch = useCallback((worktree?: string) => setLaunch({ worktree: worktree ?? null }), []);

  const [addStep, setAddStep] = useState<AddStep | null>(null);
  const openAddProject = useCallback(() => {
    void addProject().then(setAddStep);
  }, []);

  useEffect(() => {
    void start();
  }, []);
  useGitPolling();
  useUsagePolling();
  useTheme();
  useRunWatch();
  useProjectSessions();
  useMinuteClock();
  useLeaveUsageOnSelect();
  const view = useAppState().view;
  const [sidebarW, setSidebarW] = useColumnWidth(SIDEBAR);
  const [sessionsPref, setSessionsW] = useColumnWidth(SESSIONS);
  const [sideFit, sessionsW] = fitColumns(sidebarW, sessionsPref, useWindowWidth());

  // ⌘N starts a task; ⌘O adds a project; ⌘U shows usage; ⌘, settings; ⌘J cycles through the sessions waiting on you.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "n") {
        e.preventDefault();
        if (getState().selectedProject) openLaunch();
      } else if (e.key === ",") {
        e.preventDefault();
        setState((s) => ({ view: s.view === "settings" ? "sessions" : "settings" }));
      } else if (e.key === "u") {
        e.preventDefault();
        setState((s) => ({ view: s.view === "usage" ? "sessions" : "usage" }));
      } else if (e.key === "o") {
        e.preventDefault();
        openAddProject();
      } else if (e.key === "j") {
        e.preventDefault();
        const s = getState();
        const waiting = waitingAgents(s);
        if (!waiting.length) return;
        const sel = s.selectedSession;
        const at = sel && "Agent" in sel ? waiting.findIndex((a) => a.id === sel.Agent) : -1;
        selectAgent(waiting[(at + 1) % waiting.length]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openLaunch, openAddProject]);

  return (
    <div
      className={`app${view !== "sessions" ? " is-overlay" : ""}`}
      style={{ "--w-sidebar": `${sideFit}px`, "--w-sessions": `${sessionsW}px` } as React.CSSProperties}
    >
      <div className="column">
        <Sidebar onAddProject={openAddProject} />
        <Resizer spec={SIDEBAR} width={sideFit} onWidth={setSidebarW} />
      </div>
      {/* Usage and settings lie over the sessions and terminal rather than
          replacing them, so the terminal keeps its session attached. */}
      <div className="column column-sessions" inert={view !== "sessions"}>
        <Sessions onNewTask={openLaunch} />
        <Resizer spec={SESSIONS} width={sessionsW} onWidth={setSessionsW} />
      </div>
      <div className="column column-terminal" inert={view !== "sessions"}>
        <TerminalPane onNewTask={() => openLaunch()} />
      </div>
      {view === "usage" && <UsageView />}
      {view === "settings" && <SettingsView />}
      {launch && <LaunchDialog initialWorktree={launch.worktree} onClose={() => setLaunch(null)} />}
      {addStep && <AddProjectDialog step={addStep} onDone={setAddStep} />}
      <Notice />
      <DaemonGate />
    </div>
  );
}

/** Keeps `state.minute` current, for views that expire with the clock. */
function useMinuteClock() {
  useEffect(() => {
    const t = setInterval(() => {
      const minute = Math.floor(Date.now() / 60_000);
      if (minute !== getState().minute) setState({ minute });
    }, 10_000);
    return () => clearInterval(t);
  }, []);
}

/** Picking a project or session anywhere (the sidebar, ⌘J, a new task, a
 *  notification) means you want to see it: leave usage or settings. */
function useLeaveUsageOnSelect() {
  useEffect(() => {
    let { selectedProject, selectedSession } = getState();
    return subscribe(() => {
      const s = getState();
      if (s.selectedProject !== selectedProject || s.selectedSession !== selectedSession) {
        selectedProject = s.selectedProject;
        selectedSession = s.selectedSession;
        if (s.view !== "sessions") setState({ view: "sessions" });
      }
    });
  }, []);
}
