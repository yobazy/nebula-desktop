import { useCallback, useEffect, useMemo, useState } from "react";
import { Sidebar, selectAgent } from "./components/Sidebar";
import { Sessions } from "./components/Sessions";
import { TerminalPane } from "./components/TerminalPane";
import { LaunchDialog } from "./components/LaunchDialog";
import type { Seed } from "./components/RowMenu";
import { DaemonGate } from "./components/DaemonGate";
import { AddProjectDialog, Notice, addProject, type AddStep } from "./components/AddProject";
import { start } from "./nebula/client";
import { useGitPolling } from "./nebula/git";
import { fitColumns, Resizer, SESSIONS, SIDEBAR, useColumnWidth, useHidden, useWindowWidth } from "./components/Resizer";
import { PanelGlyph } from "./components/Sidebar";
import { UsageView } from "./components/Usage";
import { SettingsView } from "./components/Settings";
import { useUsagePolling } from "./nebula/usage";
import { useTheme } from "./nebula/theme";
import { useRunWatch } from "./nebula/runs";
import { useLimitWatch } from "./nebula/limits";
import { useProjectSessions } from "./nebula/focus";
import { useProjectLogos } from "./nebula/icons";
import { flash, getState, setState, subscribe, useAppState, waitingAgents } from "./nebula/store";
import { usePrPolling } from "./nebula/prs";
import { useQueueRunner } from "./nebula/queue";
import { ReviewView } from "./components/Review";
import { CompareView } from "./components/Compare";
import { GridView } from "./components/Grid";
import { useDesktopShell } from "./nebula/desktop";
import { useDelight } from "./nebula/delight";
import { useBudgetWatch } from "./nebula/budget";
import { useFileDrop } from "./nebula/dropfiles";
import { useFanOutPrune } from "./nebula/fanout";
import { Palette, type PaletteContext } from "./components/Palette";
import { TextDialog, type TextDialogSpec } from "./components/Dialogs";

export default function App() {
  const [launch, setLaunch] = useState<{ worktree: string | null; seed?: Seed; pickProject?: boolean } | null>(null);
  // Each opening is a new dialog (see the key below), never an update to one
  // that is already mounted.
  const [launchKey, setLaunchKey] = useState(0);
  const openLaunch = useCallback((worktree?: string, seed?: Seed) => {
    setLaunchKey((k) => k + 1);
    setLaunch({ worktree: worktree ?? null, seed });
  }, []);
  // Quick capture (the global hotkey, the menu bar): from anywhere, so the
  // project is picked in the dialog.
  const openCapture = useCallback(() => {
    setState({ view: "sessions" });
    setLaunchKey((k) => k + 1);
    setLaunch({ worktree: null, pickProject: true });
  }, []);
  const openAgent = useCallback((id: string) => {
    const a = getState().agents[id];
    if (a) selectAgent(a);
  }, []);
  useDesktopShell(openCapture, openAgent);
  const [grid, setGrid] = useGridMode();

  const [addStep, setAddStep] = useState<AddStep | null>(null);
  const openAddProject = useCallback(() => {
    void addProject()
      .then(setAddStep)
      .catch((e) => flash(`Couldn't open the folder picker: ${e instanceof Error ? e.message : String(e)}`));
  }, []);

  useEffect(() => {
    void start();
  }, []);
  useGitPolling();
  usePrPolling();
  useDelight();
  useBudgetWatch();
  useFileDrop();
  useFanOutPrune();
  useQueueRunner();
  useUsagePolling();
  useTheme();
  useRunWatch();
  useLimitWatch();
  useProjectSessions();
  useProjectLogos();
  useMinuteClock();
  useLeaveUsageOnSelect();
  const view = useAppState().view;
  const [sidebarW, setSidebarW] = useColumnWidth(SIDEBAR);
  const [sessionsPref, setSessionsW] = useColumnWidth(SESSIONS);
  const [hideProjects, setHideProjects] = useHidden("projects");
  const [hideTasks, setHideTasks] = useHidden("tasks");
  const [sidebarCol, sessionsW] = fitColumns(
    hideProjects ? null : sidebarW,
    hideTasks ? null : sessionsPref,
    useWindowWidth(),
  );
  // Buttons to bring hidden columns back, at the terminal's top left — after
  // the window's traffic lights when nothing else is left of it.
  const [palette, setPalette] = useState(false);
  const [textDialog, setTextDialog] = useState<TextDialogSpec | null>(null);
  const paletteCtx = useMemo<PaletteContext>(
    () => ({
      newTask: () => openLaunch(),
      addProject: openAddProject,
      toggleProjects: () => setHideProjects((h) => !h),
      toggleTasks: () => setHideTasks((h) => !h),
      toggleGrid: () => setGrid((g) => !g),
      prompt: setTextDialog,
    }),
    [openLaunch, openAddProject, setHideProjects, setHideTasks, setGrid],
  );

  const reveal = [
    hideProjects && { label: "Show projects (⌘B)", run: () => setHideProjects(false) },
    hideTasks && { label: "Show tasks (⌥⌘B)", run: () => setHideTasks(false) },
  ].filter(Boolean) as { label: string; run: () => void }[];
  const revealLeft = hideProjects && hideTasks ? 80 : 10;

  // ⌘K opens the palette; ⌘N starts a task; ⌘O adds a project; ⌘U shows usage; ⌘, settings; ⌘J cycles through the sessions waiting on you.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "g") {
        e.preventDefault();
        setGrid((g) => !g);
      } else if (e.key === "n") {
        e.preventDefault();
        if (Object.keys(getState().projects).length) openLaunch();
        else flash("Add a project first (⌘O).");
      } else if (e.code === "KeyB") {
        e.preventDefault();
        if (e.altKey) setHideTasks((h) => !h);
        else setHideProjects((h) => !h);
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
  }, [openLaunch, openAddProject, setHideProjects, setHideTasks, setGrid]);

  return (
    <div
      className={`app${view !== "sessions" ? " is-overlay" : ""}`}
      style={
        {
          "--w-sidebar": `${sidebarCol}px`,
          "--w-sessions": `${sessionsW}px`,
          "--reveal-pad": reveal.length ? `${revealLeft + reveal.length * 30}px` : "0px",
        } as React.CSSProperties
      }
    >
      <div className="column column-sidebar" hidden={hideProjects}>
        {!hideProjects && (
          <>
            <Sidebar onAddProject={openAddProject} onHide={() => setHideProjects(true)} />
            <Resizer spec={SIDEBAR} width={sidebarCol} onWidth={setSidebarW} />
          </>
        )}
      </div>
      {/* Usage and settings lie over the sessions and terminal rather than
          replacing them, so the terminal keeps its session attached. */}
      <div className="column column-sessions" inert={view !== "sessions"} hidden={hideTasks}>
        {!hideTasks && (
          <>
            <Sessions onNewTask={openLaunch} onHide={() => setHideTasks(true)} />
            <Resizer spec={SESSIONS} width={sessionsW} onWidth={setSessionsW} />
          </>
        )}
      </div>
      <div className="column column-terminal" inert={view !== "sessions"}>
        {reveal.length > 0 && (
          <div className="reveal" style={{ left: revealLeft }}>
            {reveal.map((r) => (
              <button key={r.label} className="icon-btn" onClick={r.run} title={r.label} aria-label={r.label}>
                <PanelGlyph />
              </button>
            ))}
          </div>
        )}
        {grid ? <GridView onExit={() => setGrid(false)} /> : <TerminalPane onNewTask={() => openLaunch()} />}
      </div>
      {view === "usage" && <UsageView />}
      {view === "settings" && <SettingsView />}
      {view === "review" && <ReviewView key={getState().review ?? ""} />}
      {view === "compare" && <CompareView />}
      {launch && (
        <LaunchDialog
          key={launchKey}
          initialWorktree={launch.worktree}
          seed={launch.seed}
          pickProject={launch.pickProject}
          onClose={() => setLaunch(null)}
        />
      )}
      {addStep && <AddProjectDialog step={addStep} onDone={setAddStep} />}
      {palette && <Palette ctx={paletteCtx} onClose={() => setPalette(false)} />}
      {textDialog && <TextDialog d={textDialog} onClose={() => setTextDialog(null)} />}
      <Notice />
      <DaemonGate />
    </div>
  );
}

/** Whether the terminal column shows the grid (⌘G), remembered across launches. */
function useGridMode(): [boolean, (v: boolean | ((v: boolean) => boolean)) => void] {
  const [grid, setGrid] = useState(() => {
    try {
      return localStorage.getItem("nebula-desktop.grid") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("nebula-desktop.grid", grid ? "1" : "0");
    } catch {
      // A convenience: it resets to one terminal next launch.
    }
  }, [grid]);
  return [grid, setGrid];
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
