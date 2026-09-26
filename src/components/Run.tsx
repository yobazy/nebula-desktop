import { useEffect, useRef, useState } from "react";
import { isPreview } from "../nebula/client";
import { runOnWorktree } from "../nebula/actions";
import { NoRunCommand, runTerminal, SETUP_RUN_PROMPT, startRun, stopRun } from "../nebula/runs";
import { writeProjectSetting } from "../nebula/settings";
import { flash, getState, setState, useAppState } from "../nebula/store";
import type { Worktree } from "../nebula/types";

export async function openLink(url: string) {
  if (isPreview()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

const pretty = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Start a worktree's run command, asking how to when there isn't one. */
function useStart(worktree: Worktree) {
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await startRun(worktree.id);
      // The run terminal is in the store by the time StartRun is answered.
      const term = runTerminal(getState(), worktree.id);
      if (term) setState({ selectedSession: { Terminal: term.id } });
    } catch (e) {
      if (e instanceof NoRunCommand) setSetup(true);
      else flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, setup, setSetup, start };
}

/** The project header's Start/Stop for the main checkout. Where it's live
 *  shows on the main band's run line, right under it. */
export function ProjectRun({ worktree }: { worktree: Worktree }) {
  const state = useAppState();
  const live = runTerminal(state, worktree.id)?.alive;
  const { busy, setup, setSetup, start } = useStart(worktree);

  return (
    <div className="project-run">
      {live ? (
        <button className="btn" onClick={() => void stopRun(worktree.id).catch((e) => flash(String(e)))} title="Stop the run command">
          <StopGlyph /> Stop
        </button>
      ) : (
        <button className="btn" onClick={() => void start()} disabled={busy} title="Run the project's start command">
          <PlayGlyph /> {busy ? "Starting…" : "Start"}
        </button>
      )}
      {setup && <RunSetupDialog worktree={worktree} onClose={() => setSetup(false)} onSaved={() => void start()} />}
    </div>
  );
}

/** A band's run state: a ▶ in its actions, and a live line while it runs. */
export function BandRunButton({ worktree }: { worktree: Worktree }) {
  const state = useAppState();
  const term = runTerminal(state, worktree.id);
  const { busy, setup, setSetup, start } = useStart(worktree);
  if (term?.alive) return null;
  return (
    <>
      <button
        className="icon-btn"
        onClick={() => void start()}
        disabled={busy}
        title={`Start the project on ${worktree.branch}`}
        aria-label={`Start the project on ${worktree.branch}`}
      >
        <PlayGlyph />
      </button>
      {setup && <RunSetupDialog worktree={worktree} onClose={() => setSetup(false)} onSaved={() => void start()} />}
    </>
  );
}

export function BandRunLine({ worktree }: { worktree: Worktree }) {
  const state = useAppState();
  const term = runTerminal(state, worktree.id);
  if (!term?.alive) return null;
  const url = state.runUrls[term.id];
  return (
    <p className="run-line">
      <span className="live-dot" aria-hidden />
      <button className="link-btn run-name" onClick={() => setState({ selectedSession: { Terminal: term.id } })} title={term.run_command ?? ""}>
        Running
      </button>
      {url ? (
        <button className="link-btn" onClick={() => void openLink(url)} title={`Open ${url}`}>
          {pretty(url)} ↗
        </button>
      ) : (
        <span className="git-muted">waiting for an address…</span>
      )}
      <button className="link-btn run-stop" onClick={() => void stopRun(worktree.id).catch((e) => flash(String(e)))}>
        Stop
      </button>
    </p>
  );
}

/** No run command anywhere: type one (saved as the project's Run command
 *  setting, which the TUI shares), or hand the question to an agent. */
function RunSetupDialog({
  worktree,
  onClose,
  onSaved,
}: {
  worktree: Worktree;
  onClose: () => void;
  onSaved: () => void;
}) {
  const state = useAppState();
  const project = state.projects[worktree.project_id];
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!project) return null;
  const main =
    Object.values(state.worktrees).find((w) => w.project_id === project.id && w.is_main)?.id ?? worktree.id;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog dialog-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-setup-title"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!cmd.trim() || busy) return;
          setBusy(true);
          try {
            await writeProjectSetting(project.repo_path, "run_command", cmd);
            onClose();
            onSaved();
          } catch (err) {
            flash(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
            setBusy(false);
          }
        }}
      >
        <h2 id="run-setup-title">How does {project.name} start?</h2>
        <p className="dialog-body">
          There's no run command yet. Type the one you'd use in a terminal. It's saved as this
          project's Run command, which the TUI uses too.
        </p>
        <input
          ref={input}
          className="setting-input run-input"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="npm run dev"
          spellCheck={false}
          aria-label="Run command"
        />
        <footer className="dialog-foot">
          <button
            type="button"
            className="link-btn hint"
            disabled={busy}
            onClick={async () => {
              onClose();
              try {
                await runOnWorktree(main, SETUP_RUN_PROMPT, `work out how ${project.name} starts`);
              } catch (err) {
                flash(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Ask an agent to work it out
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !cmd.trim()}>
            Save & start
          </button>
        </footer>
      </form>
    </div>
  );
}

export function PlayGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
      <path d="M4.5 2.8v10.4L13 8 4.5 2.8Z" fill="currentColor" />
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}
