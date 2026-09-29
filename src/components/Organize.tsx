import { useEffect, useRef, useState } from "react";
import { PROJECT_COLORS } from "../nebula/icons";
import { followUpAgents, setTaskColor, toggleFlag } from "../nebula/organize";
import { relativeTime } from "../nebula/status";
import { flash, projectOfWorktree, useAppState } from "../nebula/store";
import type { Agent } from "../nebula/types";
import { ProjectDot, selectAgent } from "./Sidebar";

/** The eight colors and "none", as a radio row. */
export function ColorRow({
  value,
  onPick,
  labelledBy,
}: {
  value: string | null;
  onPick: (name: string | null) => void;
  labelledBy: string;
}) {
  return (
    <div className="color-row" role="radiogroup" aria-labelledby={labelledBy}>
      <button
        role="radio"
        aria-checked={!value}
        className={`color-swatch color-none${!value ? " is-on" : ""}`}
        onClick={() => onPick(null)}
        title="No color"
        aria-label="No color"
      />
      {PROJECT_COLORS.map((c) => (
        <button
          key={c.name}
          role="radio"
          aria-checked={value === c.name}
          className={`color-swatch${value === c.name ? " is-on" : ""}`}
          style={{ "--pc": c.hue } as React.CSSProperties}
          onClick={() => onPick(c.name)}
          title={c.name}
          aria-label={c.name}
        />
      ))}
    </div>
  );
}

/** A task's color as `--pc` (its hue), or nothing when it has none. */
export function useTaskColorStyle(agent: Agent): React.CSSProperties | undefined {
  const name = useAppState().prefs.taskColors?.[agent.id];
  const hue = PROJECT_COLORS.find((c) => c.name === name)?.hue;
  return hue === undefined ? undefined : ({ "--pc": hue } as React.CSSProperties);
}

/** Pick a color for a task: one click picks and closes. */
export function TaskColorDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const color = useAppState().prefs.taskColors?.[agent.id] ?? null;
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="dialog dialog-narrow task-color" role="dialog" aria-modal="true" aria-labelledby="task-color-title">
        <h2 id="task-color-title">Color {agent.name}</h2>
        <ColorRow
          value={color}
          labelledBy="task-color-title"
          onPick={(name) => {
            void setTaskColor(agent.id, name).catch((e) => flash(`Couldn't save the color: ${e}`));
            onClose();
          }}
        />
      </div>
    </div>
  );
}

/** How many flagged tasks show before "Show all". */
const FOLLOW_UP_ROWS = 5;

/** Tasks flagged to come back to, across projects. Those waiting on you
 *  are left to the list above, which already shows them. */
export function FollowUps() {
  const state = useAppState();
  const [all, setAll] = useState(false);
  const flagged = followUpAgents(state).filter(({ agent }) => agent.status !== "needs_feedback" || agent.archived);
  if (flagged.length === 0) return null;
  const shown = all ? flagged : flagged.slice(0, FOLLOW_UP_ROWS);
  return (
    <section className="followups" aria-label="Flagged for follow-up">
      <h2 className="followups-title">
        <FlagGlyph />
        Follow up <span className="followups-count">{flagged.length}</span>
      </h2>
      <ul>
        {shown.map(({ agent, at }) => {
          const project = projectOfWorktree(state, agent.worktree_id);
          return (
            <li key={agent.id}>
              <button className="followup-row" onClick={() => selectAgent(agent)}>
                <span className="followup-name">{agent.name}</span>
                <span className="followup-where">
                  <span className="followup-project">
                    <ProjectDot project={project} />
                    {project?.name}
                    {agent.archived && " · archived"}
                  </span>
                  <span className="followup-age" title={`Flagged ${new Date(at).toLocaleString()}`}>
                    {relativeTime(at)}
                  </span>
                </span>
              </button>
              <button
                className="followup-clear"
                onClick={() => void toggleFlag(agent)}
                aria-label={`Clear the flag on ${agent.name}`}
                title="Done: clear the flag"
              >
                <CheckGlyph />
              </button>
            </li>
          );
        })}
      </ul>
      {flagged.length > FOLLOW_UP_ROWS && (
        <button className="link-btn followups-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${flagged.length}`}
        </button>
      )}
    </section>
  );
}

export function FlagGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 14.5V2m0 .5h8.2l-1.9 3.2 1.9 3.3H3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function PinGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M6 2h4M6.5 2v4.2L4 9h8L9.5 6.2V2M8 9v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
