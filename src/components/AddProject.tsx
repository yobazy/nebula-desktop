import { useEffect, useRef, useState } from "react";
import { inspectFolder, pickFolder, request } from "../nebula/client";
import { flash, getState, setState, useAppState } from "../nebula/store";

/** What the add-project flow stopped to ask about, or the daemon's refusal. */
export type AddStep =
  | { kind: "create"; path: string }
  | { kind: "init"; path: string }
  | { kind: "error"; path: string; message: string };

function parentOf(path: string): string | undefined {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : undefined;
}

/** The project that already owns `path`: it, or a folder above it, is a
 *  project's repo or one of its checkouts (the TUI's `project_at_path`). */
function projectAt(path: string) {
  const s = getState();
  const owners = new Map<string, string>();
  for (const p of Object.values(s.projects)) owners.set(p.repo_path, p.id);
  for (const w of Object.values(s.worktrees)) owners.set(w.path, w.project_id);
  for (let dir: string | undefined = path; dir; dir = parentOf(dir)) {
    const id = owners.get(dir);
    if (id && s.projects[id]) return s.projects[id];
  }
  return undefined;
}

async function register(path: string, createMissing: boolean): Promise<AddStep | null> {
  try {
    const created = await request("AddProject", {
      path,
      name: null,
      create_missing: createMissing,
    });
    if (created && "Project" in created) {
      setState({ selectedProject: created.Project, selectedSession: null });
    }
    return null;
  } catch (e) {
    return { kind: "error", path, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Pick a folder and add it, the way the TUI's open-project prompt does: a
 *  folder that is already a project opens that project; a missing one or one
 *  outside any git repository comes back as a step to confirm first. */
export async function addProject(): Promise<AddStep | null> {
  const s = getState();
  const current = s.selectedProject ? s.projects[s.selectedProject] : undefined;
  // Projects tend to live side by side, so start beside the one in view.
  const picked = await pickFolder(current && parentOf(current.repo_path));
  if (!picked) return null;

  const folder = await inspectFolder(picked);
  if (!folder.exists) return { kind: "create", path: picked };

  const known = projectAt(folder.path);
  if (known) {
    setState({ selectedProject: known.id });
    flash(`${known.name} is already a project, so it's open now`);
    return null;
  }
  if (!folder.inGitRepo) return { kind: "init", path: picked };
  return register(picked, false);
}

const COPY = {
  create: {
    title: "Create folder",
    body: (p: string) => `${p} doesn't exist. Create it and make it a git repository?`,
    confirm: "Create project",
  },
  init: {
    title: "Not a git repository",
    body: (p: string) => `${p} isn't a git repository, and nebula projects are. Run git init in it?`,
    confirm: "Run git init",
  },
  error: {
    title: "Couldn't add project",
    body: (p: string) => p,
    confirm: "",
  },
};

export function AddProjectDialog({
  step,
  onDone,
}: {
  step: AddStep;
  onDone: (next: AddStep | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const copy = COPY[step.kind];

  useEffect(() => {
    (confirmBtn.current ?? closeBtn.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onDone(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onDone]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onDone(null)}>
      <form
        className="dialog dialog-narrow"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        aria-describedby="add-project-body"
        onSubmit={async (e) => {
          e.preventDefault();
          if (step.kind === "error" || busy) return;
          setBusy(true);
          onDone(await register(step.path, true));
        }}
      >
        <h2 id="add-project-title">{copy.title}</h2>
        <p id="add-project-body" className={step.kind === "error" ? "dialog-error" : "dialog-body"}>
          {step.kind === "error" ? step.message : copy.body(step.path)}
        </p>
        <footer className="dialog-foot">
          <span className="hint" />
          {step.kind === "error" ? (
            <button ref={closeBtn} type="button" className="btn" onClick={() => onDone(null)}>
              OK
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => onDone(null)} disabled={busy}>
                Cancel
              </button>
              <button ref={confirmBtn} type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Adding…" : copy.confirm}
              </button>
            </>
          )}
        </footer>
      </form>
    </div>
  );
}

export function Notice() {
  const notice = useAppState().notice;
  return notice ? (
    <div className="notice" role="status">
      {notice}
    </div>
  ) : null;
}
