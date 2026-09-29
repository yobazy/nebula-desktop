import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview, request, tailOutput } from "../nebula/client";
import { enqueue, isIdle } from "../nebula/queue";
import { needsForce } from "../nebula/actions";
import { ANSI, NoRunCommand, runTerminal, startRun, stopRun } from "../nebula/runs";
import { flash, getState, setState } from "../nebula/store";
import type { Agent, AgentKind, TerminalTab, Worktree } from "../nebula/types";
import { ContextMenu, type MenuItem } from "./Menu";
import { openLink, RunSetupDialog } from "./Run";
import { openReview } from "../nebula/diff";
import { ConfirmDialog, TextDialog, type ConfirmDialogSpec, type TextDialogSpec } from "./Dialogs";
import { isFollowUp, isPinned, moveTask, toggleFlag, unpinAll, unpinTask } from "../nebula/organize";
import { TaskColorDialog } from "./Organize";

export type Seed = { task: string; kind: AgentKind };

type Dialog =
  | TextDialogSpec
  | ConfirmDialogSpec
  | { kind: "run-setup"; worktree: Worktree }
  | { kind: "task-color"; agent: Agent };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Do `what`, and say so in the notice line if it fails. */
async function attempt(what: Promise<unknown>) {
  try {
    await what;
  } catch (e) {
    flash(errText(e));
  }
}

/** Rename (auto): have Claude title the task from its prompts and the end
 *  of its terminal output, and rename it to that. */
async function autoRename(agent: Agent) {
  flash(`Naming ${agent.name}…`);
  const tail = agent.alive ? await tailOutput({ Agent: agent.id }, 32_768, null) : null;
  const output = tail
    ? new TextDecoder()
        .decode(tail.data)
        .replace(ANSI, "")
        .split(/\r?\n|\r/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n")
        .slice(-4_000)
    : "";
  const prompts = agent.recent_prompts.map((p) => p.text);
  const name = isPreview()
    ? "Suggested Task Name"
    : await invoke<string>("suggest_title", { prompts, output });
  if (name === agent.name) return flash(`${agent.name} already fits`);
  await request("RenameAgent", { id: agent.id, name });
  flash(`Renamed to ${name}`);
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
    const autoName: MenuItem = { label: "Rename (auto)", run: () => void attempt(autoRename(a)) };
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
    // Arranging it: the desktop app's own marks, kept in its prefs.
    const followUp: MenuItem = {
      label: isFollowUp(s, a.id) ? "Clear flag" : "Flag for follow-up",
      keys: "F",
      separated: true,
      run: () => void attempt(toggleFlag(a)),
    };
    const pins = (s.prefs.pinnedTasks?.[a.worktree_id] ?? []).filter((id) => s.agents[id] && !s.agents[id].archived);
    const arrange: MenuItem[] = [
      followUp,
      isPinned(s, a)
        ? { label: "Unpin", run: () => void attempt(unpinTask(a)) }
        : { label: "Pin to top", run: () => void attempt(moveTask(a, 0)) },
      ...(pins.length > 1 || (pins.length === 1 && pins[0] !== a.id)
        ? [{ label: `Unpin all on ${wt?.branch ?? "this branch"}`, run: () => void attempt(unpinAll(a.worktree_id)) }]
        : []),
      { label: "Color…", run: () => setDialog({ kind: "task-color", agent: a }) },
    ];
    const issue: MenuItem[] = a.issue_url ? [{ label: "Open issue", run: () => void openLink(a.issue_url!) }] : [];

    if (a.archived) {
      return [
        { label: "Unarchive", run: () => void attempt(request("UnarchiveAgent", { id: a.id })) },
        duplicate,
        followUp,
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
        autoName,
        ...arrange,
        { label: "Archive", separated: true, run: () => void attempt(request("ArchiveAgent", { id: a.id })) },
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
            note: isIdle(a) ? undefined : `${a.name} is mid-turn: this waits in its queue and is sent when the turn ends.`,
            onSubmit: async (text) => {
              if ((await enqueue(a, text)) === "queued") flash(`Queued for ${a.name}`);
            },
          }),
      },
      { label: "Restart", run: () => void attempt(request("RestartAgent", { id: a.id })) },
      duplicate,
      rename,
      autoName,
      ...arrange,
      { label: "Archive", separated: true, run: () => void attempt(request("ArchiveAgent", { id: a.id })) },
    ];
    if (wt) items.splice(2, 0, { label: "Review changes", run: () => openReview(wt.id) });
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
          if (!force && needsForce(e)) {
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
      {dialog?.kind === "task-color" && <TaskColorDialog agent={dialog.agent} onClose={() => setDialog(null)} />}
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
