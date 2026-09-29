import { useEffect, useMemo, useRef, useState } from "react";
import {
  flash,
  getState,
  projectOfWorktree,
  setState,
  sortedProjects,
  urgency,
  waitingAgents,
  type State,
} from "../nebula/store";
import { request } from "../nebula/client";
import { relativeTime, statusLabel } from "../nebula/status";
import { shipKind } from "../nebula/git";
import { runOnWorktree, SHIP_LABEL, shipPrompt, shipWhat } from "../nebula/actions";
import { openReview } from "../nebula/diff";
import { runTerminal, startRun, stopRun } from "../nebula/runs";
import { enqueue, isIdle } from "../nebula/queue";
import { openCompare } from "../nebula/fanout";
import { currentEditor, openInEditor } from "./Editor";
import { selectAgent } from "./Sidebar";
import type { TextDialogSpec } from "./Dialogs";
import type { Agent } from "../nebula/types";

export interface PaletteContext {
  newTask: () => void;
  addProject: () => void;
  toggleProjects: () => void;
  toggleTasks: () => void;
  toggleGrid: () => void;
  prompt: (d: TextDialogSpec) => void;
}

interface Item {
  id: string;
  group: "Actions" | "Tasks" | "Projects";
  label: string;
  detail?: string;
  keys?: string;
  run: () => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The worktree the palette's branch actions act on: the open session's,
 *  else the selected project's main checkout. */
function currentWorktree(s: State): string | null {
  const sel = s.selectedSession;
  const fromSession = sel && ("Agent" in sel ? s.agents[sel.Agent]?.worktree_id : s.terminals[sel.Terminal]?.worktree_id);
  if (fromSession) return fromSession;
  return Object.values(s.worktrees).find((w) => w.project_id === s.selectedProject && w.is_main)?.id ?? null;
}

function build(s: State, ctx: PaletteContext): Item[] {
  const items: Item[] = [];
  const act = (id: string, label: string, run: () => void, keys?: string, detail?: string) =>
    items.push({ id: `act:${id}`, group: "Actions", label, run, keys, detail });

  if (s.selectedProject) act("new", "New task", ctx.newTask, "⌘N");
  const waiting = waitingAgents(s);
  if (waiting.length) act("waiting", "Next task waiting on you", () => selectAgent(waiting[0]), "⌘J", `${waiting.length} waiting`);

  const sel = s.selectedSession;
  const agent = sel && "Agent" in sel ? s.agents[sel.Agent] : undefined;
  if (agent && !agent.archived) {
    const idle = isIdle(agent);
    act(
      "followup",
      idle ? `Follow up with ${agent.name}` : `Queue a prompt for ${agent.name}`,
      () =>
        ctx.prompt({
          kind: "text",
          title: idle ? `Follow up with ${agent.name}` : `Queue a prompt for ${agent.name}`,
          label: "Prompt",
          initial: "",
          multiline: true,
          submit: idle ? "Send" : "Queue",
          note: idle ? undefined : "Sent as soon as the current turn ends.",
          onSubmit: async (text) => {
            if ((await enqueue(agent, text)) === "queued") flash(`Queued for ${agent.name}`);
          },
        }),
    );
    act("restart", `Restart ${agent.name}`, () => void request("RestartAgent", { id: agent.id }).catch((e) => flash(errText(e))));
    act("archive", `Archive ${agent.name}`, () => {
      void request("ArchiveAgent", { id: agent.id }).catch((e) => flash(errText(e)));
      setState({ selectedSession: null });
    });
  }

  const wtId = currentWorktree(s);
  const wt = wtId ? s.worktrees[wtId] : undefined;
  if (wt) {
    const git = s.git[wt.id];
    act("review", `Review changes on ${wt.branch}`, () => openReview(wt.id));
    const kind = git && !("error" in git) ? shipKind(git, wt) : null;
    if (git && !("error" in git) && kind)
      act("ship", `${SHIP_LABEL[kind]} ${wt.branch}`, () =>
        void runOnWorktree(wt.id, shipPrompt(kind, git), shipWhat(kind, git.branch ?? wt.branch)).catch((e) => flash(errText(e))),
      );
    const editor = currentEditor();
    if (editor) act("editor", `Open ${wt.branch} in ${editor}`, () => void openInEditor(wt, editor));
    const running = runTerminal(s, wt.id)?.alive;
    act(
      "run",
      running ? `Stop the run on ${wt.branch}` : `Start ${wt.branch}`,
      () => void (running ? stopRun(wt.id) : startRun(wt.id)).catch((e) => flash(errText(e))),
    );
  }

  for (const f of Object.values(s.fanouts)) {
    const left = f.worktrees.filter((id) => s.worktrees[id]);
    if (left.length >= 2) act(`compare:${f.id}`, `Compare ${left.length} attempts`, () => openCompare(f.id), undefined, f.prompt);
  }
  act("grid", "Watch tasks in a grid", ctx.toggleGrid, "⌘G");
  act("usage", "Claude usage", () => setState({ view: "usage" }), "⌘U");
  act("settings", "Settings", () => setState({ view: "settings" }), "⌘,");
  act("add", "Add a project", ctx.addProject, "⌘O");
  act("projects", "Hide or show projects", ctx.toggleProjects, "⌘B");
  act("tasks", "Hide or show tasks", ctx.toggleTasks, "⌥⌘B");

  const agents = Object.values(s.agents)
    .filter((a) => !a.archived)
    .sort((a, b) => urgency(a) - urgency(b) || b.status_changed_at - a.status_changed_at);
  for (const a of agents) items.push(taskItem(s, a));

  sortedProjects(s).forEach((p, i) =>
    items.push({
      id: `project:${p.id}`,
      group: "Projects",
      label: p.name,
      detail: p.repo_path.replace(/^\/Users\/[^/]+/, "~"),
      keys: i < 9 ? `⌘${i + 1}` : undefined,
      run: () => setState({ selectedProject: p.id, view: "sessions" }),
    }),
  );
  return items;
}

function taskItem(s: State, a: Agent): Item {
  const wt = s.worktrees[a.worktree_id];
  const project = projectOfWorktree(s, a.worktree_id);
  const where = [project?.name, wt && !wt.is_main ? wt.branch : null].filter(Boolean).join(" · ");
  return {
    id: `task:${a.id}`,
    group: "Tasks",
    label: a.name,
    detail: `${statusLabel(a)} ${relativeTime(a.status_changed_at)} · ${where}`,
    run: () => selectAgent(a),
  };
}

/** How well `q` matches `text`: characters in order, scored up for runs and
 *  word starts; -1 when it doesn't match at all. */
export function fuzzy(q: string, text: string): number {
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let run = 0;
  for (const ch of q.toLowerCase()) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, at);
    if (i < 0) return -1;
    run = i === at ? run + 1 : 0;
    const wordStart = i === 0 || /[\s\-_/.·]/.test(t[i - 1]);
    score += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(i - at, 5) * 0.2;
    at = i + 1;
  }
  return score + (t.startsWith(q.toLowerCase()) ? 5 : 0);
}

/** ⌘K: every task, project and action in one list you can type to filter. */
export function Palette({ ctx, onClose }: { ctx: PaletteContext; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Built once per opening: the palette is a snapshot, not a live view.
  const all = useMemo(() => build(getState(), ctx), [ctx]);

  const shown = useMemo(() => {
    const q = query.trim();
    if (!q) {
      let tasks = 0;
      return all.filter((i) => i.group !== "Tasks" || tasks++ < 40);
    }
    return all
      .map((i) => ({ i, score: Math.max(fuzzy(q, i.label), fuzzy(q, `${i.label} ${i.detail ?? ""}`) - 2) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map((r) => r.i);
  }, [all, query]);

  // Focus comes back to where it was (the terminal, usually) on close.
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      if (was?.isConnected && document.activeElement === document.body) was.focus();
    };
  }, []);
  useEffect(() => setHover(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".is-hover")?.scrollIntoView({ block: "nearest" });
  }, [hover]);

  const pick = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  let lastGroup = "";
  return (
    <div className="scrim scrim-palette" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to a task or project, or run an action…"
          aria-label="Search"
          aria-controls="palette-list"
          aria-activedescendant={shown[hover] ? `pal-${shown[hover].id}` : undefined}
          role="combobox"
          aria-expanded="true"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setHover((h) => Math.max(0, Math.min(h + 1, shown.length - 1)));
            else if (e.key === "ArrowUp") setHover((h) => Math.max(h - 1, 0));
            else if (e.key === "Enter") pick(shown[hover]);
            else if (e.key === "Escape") onClose();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shown.map((item, i) => {
            const head = !query.trim() && item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {head && <div className="palette-group">{head}</div>}
                <div
                  id={`pal-${item.id}`}
                  role="option"
                  aria-selected={i === hover}
                  className={`palette-item${i === hover ? " is-hover" : ""}`}
                  onMouseMove={() => setHover(i)}
                  onClick={() => pick(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.detail && <span className="palette-detail">{item.detail}</span>}
                  {item.keys && <kbd>{item.keys}</kbd>}
                </div>
              </li>
            );
          })}
          {shown.length === 0 && <li className="palette-empty">Nothing matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
