import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview, request } from "../nebula/client";
import { deliverPrompt } from "../nebula/actions";
import { NoRunCommand, runTerminal, startRun, stopRun } from "../nebula/runs";
import { flash, getState, setState } from "../nebula/store";
import type { Agent, AgentKind, TerminalTab, Worktree } from "../nebula/types";
import { ContextMenu, type MenuItem } from "./Menu";
import { openLink, RunSetupDialog } from "./Run";

export type Seed = { task: string; kind: AgentKind };

type Dialog =
  | { kind: "text"; title: string; label: string; initial: string; multiline?: boolean; submit: string; onSubmit: (v: string) => Promise<void> }
  /** onConfirm resolving `false` keeps the dialog: it has put up another. */
  | { kind: "confirm"; title: string; message: string; confirm: string; onConfirm: () => Promise<boolean | void> }
  | { kind: "run-setup"; worktree: Worktree };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Do `what`, and say so in the notice line if it fails. */
async function attempt(what: Promise<unknown>) {
  try {
    await what;
  } catch (e) {
    flash(errText(e));
  }
}

/** Send a follow-up to an agent. One that's asleep (reaped when idle) is
 *  woken by opening it, and gets the prompt once its CLI has had a moment
 *  to come up. */
async function followUp(agent: Agent, text: string) {
  setState({ selectedSession: { Agent: agent.id } });
  if (!agent.alive) {
    flash(`Starting ${agent.name}…`);
    const deadline = Date.now() + 20_000;
    while (!getState().agents[agent.id]?.alive) {
      if (Date.now() > deadline) throw new Error(`${agent.name} didn't start; try again once it's up`);
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 2_500));
  }
  await deliverPrompt(getState().agents[agent.id] ?? agent, text);
}

/** Show a checkout in Finder, or run the project's Open command for it. */
async function openWorktree(wt: Worktree) {
  const project = getState().projects[wt.project_id];
  if (isPreview()) {
    flash(`Opened ${wt.path}`);
    return;
  }
  const ran = await invoke<boolean>("open_worktree", { path: wt.path, repo: project?.repo_path ?? wt.path });
  if (!ran) {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(wt.path);
    flash("No Open command set, so it's shown in Finder. Set one in Settings → Project.");
  }
}

/** The right-click menus for task and terminal rows: the TUI's items, in
 *  the TUI's order (nebula-tui menu_items_for_session_in / _for_terminal). */
export function useRowMenu(onDuplicate: (worktree: string, seed: Seed) => void) {
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number; label: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = useCallback(() => setMenu(null), []);

  const agentItems = (a: Agent): MenuItem[] => {
    const s = getState();
    const wt = s.worktrees[a.worktree_id];
    const open = () => setState({ selectedSession: { Agent: a.id } });
    const rename: MenuItem = {
      label: "Rename",
      run: () =>
        setDialog({
          kind: "text",
          title: "Rename task",
          label: "Name",
          initial: a.name,
          submit: "Rename",
          onSubmit: (name) => request("RenameAgent", { id: a.id, name }).then(() => {}),
        }),
    };
    const duplicate: MenuItem = {
      label: "Duplicate",
      run: () => onDuplicate(a.worktree_id, { task: a.recent_prompts[0]?.text ?? "", kind: a.kind }),
    };
    const del: MenuItem = {
      label: "Delete",
      destructive: true,
      separated: true,
      run: () =>
        setDialog({
          kind: "confirm",
          title: `Delete ${a.name}?`,
          message: "Its session and history go with it. Archive it instead to keep them.",
          confirm: "Delete",
          onConfirm: () => request("DeleteAgent", { id: a.id }).then(() => {}),
        }),
    };
    const issue: MenuItem[] = a.issue_url ? [{ label: "Open issue", run: () => void openLink(a.issue_url!) }] : [];

    if (a.archived) {
      return [
        { label: "Unarchive", run: () => void attempt(request("UnarchiveAgent", { id: a.id })) },
        duplicate,
        ...issue,
        del,
      ];
    }
    if (a.cloud_session_id) {
      return [
        { label: "Open in browser", run: () => void openLink(`https://claude.ai/code/${a.cloud_session_id}`) },
        {
          label: "Send to cloud session",
          run: () =>
            setDialog({
              kind: "text",
              title: `Message ${a.name}`,
              label: "Message",
              initial: "",
              multiline: true,
              submit: "Send",
              onSubmit: (message) => request("SendCloudMessage", { id: a.id, message }).then(() => {}),
            }),
        },
        duplicate,
        rename,
        { label: "Archive", run: () => void attempt(request("ArchiveAgent", { id: a.id })) },
        del,
      ];
    }

    const items: MenuItem[] = [
      { label: "Open", run: open },
      {
        label: "Follow-up prompt",
        run: () =>
          setDialog({
            kind: "text",
            title: `Follow up with ${a.name}`,
            label: "Prompt",
            initial: "",
            multiline: true,
            submit: "Send",
            onSubmit: (text) => followUp(a, text),
          }),
      },
      { label: "Restart", run: () => void attempt(request("RestartAgent", { id: a.id })) },
      duplicate,
      rename,
      { label: "Archive", run: () => void attempt(request("ArchiveAgent", { id: a.id })) },
    ];
    if (wt) {
      const running = runTerminal(s, wt.id)?.alive;
      items.push(
        {
          label: running ? "Stop run" : "Run",
          separated: true,
          run: () =>
            void (running
              ? attempt(stopRun(wt.id))
              : startRun(wt.id).catch((e) =>
                  e instanceof NoRunCommand ? setDialog({ kind: "run-setup", worktree: wt }) : flash(errText(e)),
                )),
        },
        { label: "Open", run: () => void attempt(openWorktree(wt)) },
        ...issue,
      );
      if (!wt.is_main) {
        items.push({
          label: "Delete worktree",
          destructive: true,
          run: () => confirmDeleteWorktree(wt, false),
        });
      }
    }
    items.push(del);
    // The checkout's Open and the session's Open would read alike: name the
    // checkout's for what it opens.
    return items.map((it, i) => (it.label === "Open" && i > 0 ? { ...it, label: "Open worktree" } : it));
  };

  const confirmDeleteWorktree = (wt: Worktree, force: boolean) =>
    setDialog({
      kind: "confirm",
      title: `Delete the ${wt.branch} worktree?`,
      message: force
        ? "It has changes git won't drop on its own. Deleting it anyway loses them."
        : `The checkout at ${wt.path} and every session in it are removed. The branch stays.`,
      confirm: force ? "Delete anyway" : "Delete worktree",
      onConfirm: async () => {
        try {
          await request("DeleteWorktree", { id: wt.id, force });
        } catch (e) {
          // Uncommitted or unpushed work: ask again before forcing it.
          if (!force) {
            confirmDeleteWorktree(wt, true);
            return false;
          }
          throw e;
        }
      },
    });

  const terminalItems = (t: TerminalTab): MenuItem[] => [
    { label: "Open", run: () => setState({ selectedSession: { Terminal: t.id } }) },
    {
      label: "Rename",
      run: () =>
        setDialog({
          kind: "text",
          title: "Rename terminal",
          label: "Name",
          initial: t.name,
          submit: "Rename",
          onSubmit: (name) => request("RenameTerminal", { id: t.id, name }).then(() => {}),
        }),
    },
    {
      label: "Close",
      destructive: true,
      separated: true,
      run: () =>
        setDialog({
          kind: "confirm",
          title: `Close ${t.name}?`,
          message: t.run_command ? "This stops the run command." : "Anything running in it stops.",
          confirm: "Close",
          onConfirm: () => request("CloseTerminal", { id: t.id }).then(() => {}),
        }),
    },
  ];

  const openFor = (e: React.MouseEvent, target: { Agent: Agent } | { Terminal: TerminalTab }) => {
    e.preventDefault();
    // The context-menu key has no pointer position: open by the row.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX || r.left + 24;
    const y = e.clientY || r.bottom;
    if ("Agent" in target) setMenu({ items: agentItems(target.Agent), x, y, label: `${target.Agent.name} actions` });
    else setMenu({ items: terminalItems(target.Terminal), x, y, label: `${target.Terminal.name} actions` });
  };

  const element = (
    <>
      {menu && <ContextMenu {...menu} onClose={close} />}
      {dialog?.kind === "text" && <TextDialog d={dialog} onClose={() => setDialog(null)} />}
      {dialog?.kind === "confirm" && <ConfirmDialog d={dialog} onClose={() => setDialog(null)} />}
      {dialog?.kind === "run-setup" && (
        <RunSetupDialog
          worktree={dialog.worktree}
          onClose={() => setDialog(null)}
          onSaved={() => void attempt(startRun(dialog.worktree.id))}
        />
      )}
    </>
  );
  return { openFor, element };
}

function useEscape(onClose: () => void, busy: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
}

function TextDialog({ d, onClose }: { d: Extract<Dialog, { kind: "text" }>; onClose: () => void }) {
  const [text, setText] = useState(d.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEscape(onClose, busy);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await d.onSubmit(text.trim());
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog dialog-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="row-dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="row-dialog-title">{d.title}</h2>
        {d.multiline ? (
          <textarea
            ref={field}
            className="task-box"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                void submit();
              }
            }}
            aria-label={d.label}
          />
        ) : (
          <input ref={field} className="setting-input run-input" value={text} onChange={(e) => setText(e.target.value)} aria-label={d.label} spellCheck={false} />
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
          <span className="hint">
            {d.multiline && (
              <>
                <kbd>⌘</kbd>
                <kbd>↵</kbd> to send
              </>
            )}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
            {d.submit}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ConfirmDialog({ d, onClose }: { d: Extract<Dialog, { kind: "confirm" }>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEscape(onClose, busy);
  // Focus lands on Cancel: Enter on a destructive dialog shouldn't delete.
  useEffect(() => cancel.current?.focus(), []);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog dialog-narrow" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h2 id="confirm-title">{d.title}</h2>
        <p id="confirm-body" className="dialog-body">
          {d.message}
        </p>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
          <span className="hint" />
          <button ref={cancel} type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if ((await d.onConfirm()) !== false) onClose();
              } catch (e) {
                setError(errText(e));
                setBusy(false);
              }
            }}
          >
            {d.confirm}
          </button>
        </footer>
      </div>
    </div>
  );
}
