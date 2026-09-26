import { useEffect, useMemo, useRef, useState } from "react";
import { readPresets, readSettings, request } from "../nebula/client";
import { createAgent, defaultKind, HARNESSES } from "../nebula/actions";
import { projectWorktrees, useAppState } from "../nebula/store";
import { KIND_LABEL, settingsStem } from "../nebula/status";
import type { AgentKind, AgentPreset } from "../nebula/types";

const NEW_WORKTREE = "__new__";

type Settings = Record<string, unknown>;

/** A branch name from the task's first words: "Fix login redirect" → fix-login-redirect. */
function suggestBranch(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-");
}

export function LaunchDialog({
  initialWorktree,
  seed,
  onClose,
}: {
  initialWorktree: string | null;
  /** Duplicate's starting point: the task and harness to begin from. */
  seed?: { task: string; kind: AgentKind } | null;
  onClose: () => void;
}) {
  const state = useAppState();
  const projectId = state.selectedProject;
  const project = projectId ? state.projects[projectId] : undefined;
  const worktrees = useMemo(
    () => (projectId ? projectWorktrees(state, projectId) : []),
    [state, projectId],
  );

  const [settings, setSettings] = useState<Settings>({});
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [where, setWhere] = useState(initialWorktree ?? worktrees[0]?.id ?? NEW_WORKTREE);
  const [branch, setBranch] = useState("");
  const [branchTouched, setBranchTouched] = useState(false);
  const [kind, setKind] = useState<AgentKind>(seed?.kind ?? "claude");
  const [preset, setPreset] = useState<string>("");
  const [task, setTask] = useState(seed?.task ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void readSettings().then((s) => {
      setSettings(s);
      if (!seed) setKind(defaultKind(s));
      if (s.quick_prompt_new_worktree === true && !initialWorktree) setWhere(NEW_WORKTREE);
    });
    void readPresets().then(setPresets);
    taskBox.current?.focus();
  }, [initialWorktree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const enabled = HARNESSES.filter((k) =>
    k === "claude"
      ? settings.claude_enabled !== false
      : settings[`${settingsStem(k)}_enabled`] === true,
  );
  const chosenPreset = presets.find((p) => p.name === preset);
  const effectiveBranch = branchTouched ? branch : suggestBranch(task);

  async function launch() {
    if (!projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      let worktree = where;
      if (where === NEW_WORKTREE) {
        const name = effectiveBranch.trim();
        if (!name) throw new Error("Name the new branch, or pick an existing one.");
        const base = settings.worktree_base_branch;
        const created = await request("CreateWorktree", {
          project: projectId,
          branch: name,
          base: typeof base === "string" && base ? base : null,
        });
        if (!created || !("Worktree" in created)) throw new Error("The daemon did not return the new worktree.");
        worktree = created.Worktree;
      }

      await createAgent({ worktree, kind, settings, prompt: task, preset: chosenPreset });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!project) return null;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-title"
        onSubmit={(e) => {
          e.preventDefault();
          void launch();
        }}
      >
        <h2 id="launch-title">New task in {project.name}</h2>

        <textarea
          ref={taskBox}
          className="task-box"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              void launch();
            }
          }}
          placeholder={
            chosenPreset?.skip_task
              ? `“${chosenPreset.name}” needs no task. Add one if you like.`
              : "What should the agent do? Leave empty to start it idle."
          }
          rows={5}
          aria-label="Task"
        />

        <div className="field">
          <label htmlFor="launch-where">Run on</label>
          <select id="launch-where" value={where} onChange={(e) => setWhere(e.target.value)}>
            {worktrees.map((w) => (
              <option key={w.id} value={w.id}>
                {w.branch}
                {w.is_main ? " (main checkout)" : ""}
              </option>
            ))}
            <option value={NEW_WORKTREE}>A new worktree…</option>
          </select>
        </div>

        {where === NEW_WORKTREE && (
          <div className="field">
            <label htmlFor="launch-branch">Branch</label>
            <input
              id="launch-branch"
              value={effectiveBranch}
              onChange={(e) => {
                setBranch(e.target.value);
                setBranchTouched(true);
              }}
              placeholder="fix-login-redirect"
              spellCheck={false}
            />
          </div>
        )}

        {presets.length > 0 && (
          <div className="field">
            <label htmlFor="launch-preset">Preset</label>
            <select id="launch-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
              <option value="">None</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {!chosenPreset && enabled.length > 1 && (
          <div className="field">
            <span className="field-label" id="launch-agent">
              Agent
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="launch-agent">
              {enabled.map((k) => (
                <button
                  type="button"
                  key={k}
                  role="radio"
                  aria-checked={kind === k}
                  className={kind === k ? "is-on" : ""}
                  onClick={() => setKind(k)}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <footer className="dialog-foot">
          <span className="hint">
            <kbd>⌘</kbd>
            <kbd>↵</kbd> to start
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Starting…" : "Start task"}
          </button>
        </footer>
      </form>
    </div>
  );
}
