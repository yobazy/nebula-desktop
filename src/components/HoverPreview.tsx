import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { projectOfWorktree, useAppState } from "../nebula/store";
import { agentSpec, relativeTime, statusLabel } from "../nebula/status";
import { findQuestion, lastRows, readScreen } from "../nebula/screen";
import { useSessionCosts } from "../nebula/budget";
import { money, sessionKey } from "../nebula/usage";

const DELAY_MS = 450;
const POLL_MS = 2_000;
const WIDTH = 380;

/** Hover a task row (anything marked `data-agent`) inside the returned
 *  container for a moment to see where it's at: its last prompt and the
 *  end of its screen, without opening it. Delegated from the container so
 *  rows needn't know about it. */
export function useHoverPreview() {
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<string | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
    setHover(null);
  }, []);

  const onMouseOver = useCallback((e: React.MouseEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-agent]");
    const id = row?.dataset.agent ?? null;
    if (id === current.current) return;
    if (timer.current) clearTimeout(timer.current);
    current.current = id;
    setHover(null);
    if (!row || !id) return;
    timer.current = setTimeout(() => {
      // A drag or a click in the meantime moves on without a preview.
      if (current.current === id && !document.querySelector(".is-dragging")) setHover({ id, rect: row.getBoundingClientRect() });
    }, DELAY_MS);
  }, []);

  // Anything that moves the rows out from under the pointer ends it.
  useEffect(() => {
    if (!hover) return;
    const off = () => clear();
    window.addEventListener("scroll", off, true);
    window.addEventListener("mousedown", off, true);
    window.addEventListener("keydown", off, true);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("scroll", off, true);
      window.removeEventListener("mousedown", off, true);
      window.removeEventListener("keydown", off, true);
      window.removeEventListener("blur", off);
    };
  }, [hover, clear]);

  const element = hover ? <Preview id={hover.id} rect={hover.rect} /> : null;
  return { onMouseOver, onMouseLeave: clear, element };
}

function Preview({ id, rect }: { id: string; rect: DOMRect }) {
  const state = useAppState();
  const agent = state.agents[id];
  const [screen, setScreen] = useState<string[] | null | undefined>(undefined);
  const costs = useSessionCosts();

  useEffect(() => {
    if (!agent?.alive) return setScreen(null);
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    // Each read waits for the last: a slow daemon mustn't pile them up.
    const read = async () => {
      const lines = await readScreen(agent, 24_000).catch(() => null);
      if (!live) return;
      setScreen(lines);
      t = setTimeout(read, POLL_MS);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, agent?.alive]);

  if (!agent) return null;
  const wt = state.worktrees[agent.worktree_id];
  const project = projectOfWorktree(state, agent.worktree_id);
  const prompts = agent.recent_prompts;
  const last = prompts[prompts.length - 1];
  const queued = state.queue[agent.id]?.length ?? 0;
  const question = screen ? findQuestion(screen) : null;
  const cost = agent.session_id ? costs.get(sessionKey(agent.kind, agent.session_id)) : undefined;

  // Beside the row, on whichever side has room, kept inside the window.
  const left = rect.right + 10 + WIDTH < window.innerWidth ? rect.right + 10 : Math.max(8, rect.left - WIDTH - 10);
  const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - 330));

  return createPortal(
    <div className="preview" style={{ left, top, width: WIDTH }} role="tooltip">
      <header className="preview-head">
        <span className={`sdot dot-${agent.status}${agent.unseen ? " is-unseen" : ""}`} aria-hidden />
        <span className="preview-name">{agent.name}</span>
        <span className={`pill pill-${agent.status}`}>{statusLabel(agent)}</span>
      </header>
      <p className="preview-meta">
        {agentSpec(agent)} · {project?.name}
        {wt && !wt.is_main ? ` on ${wt.branch}` : ""} · {relativeTime(agent.status_changed_at) || "now"}
        {cost !== undefined && cost >= 0.01 ? ` · ${money(cost)}` : ""}
      </p>
      {last && (
        <p className="preview-prompt">
          <span className="preview-label">{prompts.length > 1 ? `Latest of ${prompts.length} prompts` : "Prompt"}</span>
          {last.text}
        </p>
      )}
      {question ? (
        <p className="preview-question">
          <span className="preview-label">Asking</span>
          {question.prompt || "A question"} ({question.choices.map((c) => c.label.split(/[,(]/)[0].trim()).join(" / ")})
        </p>
      ) : null}
      {screen === undefined ? (
        <p className="preview-muted">Reading its screen…</p>
      ) : screen === null ? (
        <p className="preview-muted">{agent.alive ? "Its screen couldn't be read." : "Asleep: its terminal wakes when you open it."}</p>
      ) : (
        <pre className="preview-screen">{lastRows(screen, 9).join("\n")}</pre>
      )}
      {queued > 0 && (
        <p className="preview-muted">
          {queued} queued {queued === 1 ? "prompt" : "prompts"} to send next
        </p>
      )}
    </div>,
    document.body,
  );
}
