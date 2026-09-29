import { useMemo, useRef, useState } from "react";
import { useOverlayKeys } from "./Overlay";
import { budgetLevel, budgets } from "../nebula/budget";
import { savePrefs } from "../nebula/theme";
import { setState, useAppState } from "../nebula/store";
import { relativeTime } from "../nebula/status";
import {
  compact,
  money,
  refreshUsage,
  summarize,
  type ProjectRow,
  type UsageSummary,
} from "../nebula/usage";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Where your Claude usage went: the current 5-hour window, by project, by
 *  task, and day by day. Spend is API-equivalent dollars — see usage.ts. */
export function UsageView() {
  const state = useAppState();
  const [days, setDays] = useState<number>(7);
  const [project, setProject] = useState<string | null>(null);
  const report = state.usage;
  const controls = useRef<HTMLDivElement>(null);
  useOverlayKeys(controls);
  const summary = useMemo(
    () => (report ? summarize(report, state, { days, project }) : null),
    // Worktrees and agents decide attribution, and the minute when a window
    // has run out; git polls and the like don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, state.worktrees, state.agents, state.projects, state.minute, days, project],
  );
  const filtered = project ? summary?.projects.find((p) => p.key === project)?.label : null;

  return (
    <section className="usage" aria-labelledby="usage-title">
      <header className="usage-head" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <h1 id="usage-title">Claude usage</h1>
          <p className="usage-sub">
            From Claude Code's logs on this Mac, priced at API rates. Your plan's limit isn't
            recorded locally, so this is spend, not a percentage of it.
          </p>
        </div>
        <div className="usage-controls" ref={controls}>
          <div className="segmented segmented-sm" role="radiogroup" aria-label="Range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                role="radio"
                aria-checked={days === r.days}
                className={days === r.days ? "is-on" : ""}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" onClick={() => void refreshUsage()}>
            Refresh
          </button>
          <button className="btn btn-sm" onClick={() => setState({ view: "sessions" })} title="Back to sessions (Esc)">
            Done
          </button>
        </div>
      </header>

      {!summary ? (
        <p className="usage-empty">
          {state.usageError ? `Couldn't read usage: ${state.usageError}` : "Reading Claude Code's logs…"}
        </p>
      ) : (
        <div className="usage-body">
          <Tiles summary={summary} days={days} />
          <Budgets />

          <div className="usage-grid">
            <section className="usage-card" aria-labelledby="by-project">
              <header className="usage-card-head">
                <h2 id="by-project">By project</h2>
                {project && (
                  <button className="link-btn" onClick={() => setProject(null)}>
                    Show all
                  </button>
                )}
              </header>
              <ProjectBars
                rows={summary.projects}
                total={summary.range.cost}
                selected={project}
                onSelect={(k) => setProject(k === project ? null : k)}
              />
            </section>

            <section className="usage-card" aria-labelledby="per-day">
              <header className="usage-card-head">
                <h2 id="per-day">Per day</h2>
                <span className="usage-note">last 14 days{filtered ? ", all projects" : ""}</span>
              </header>
              <DailyBars daily={summary.daily} />
            </section>
          </div>

          <section className="usage-card" aria-labelledby="by-task">
            <header className="usage-card-head">
              <h2 id="by-task">Heaviest tasks{filtered ? ` in ${filtered}` : ""}</h2>
              <span className="usage-note">click a nebula task to open it</span>
            </header>
            <TaskTable summary={summary} />
          </section>

          {report && (
            <p className="usage-foot">
              {report.files} logs under {report.root}. Weekly limits and plan caps aren't in these
              logs; check Claude's usage page for those.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Budgets you'd like to stay under, and how close you are: set right
 *  where you look at spend. Saved with the desktop prefs. */
function Budgets() {
  const state = useAppState();
  const list = useMemo(
    () => budgets(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.usage, state.prefs, state.minute],
  );
  const { prefs } = state;
  const field = (kind: "dailyBudget" | "weeklyBudget", label: string) => (
    <label className="budget-field">
      <span>{label}</span>
      <span className="budget-input">
        $
        <input
          // Re-read when the pref changes elsewhere (or loads late).
          key={prefs[kind] ?? "none"}
          type="number"
          min={0}
          step={5}
          inputMode="decimal"
          defaultValue={prefs[kind] ?? ""}
          placeholder="none"
          aria-label={`${label} budget in dollars`}
          onBlur={(e) => {
            const v = Number(e.target.value);
            const next = e.target.value.trim() && v > 0 ? v : undefined;
            if (next !== prefs[kind]) void savePrefs({ ...prefs, [kind]: next });
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </span>
    </label>
  );
  return (
    <section className="usage-card budgets" aria-labelledby="budgets-title">
      <header className="usage-card-head">
        <h2 id="budgets-title">Budgets</h2>
        <span className="usage-note">a nudge at 80% and at 100%</span>
      </header>
      <div className="budget-row">
        {field("dailyBudget", "Daily")}
        {field("weeklyBudget", "Last 7 days")}
        <div className="budget-bars">
          {list.length === 0 ? (
            <p className="usage-note">Set one to see how close you are.</p>
          ) : (
            list.map((b) => (
              <div key={b.kind} className={`budget-bar${b.share >= 1 ? " is-over" : b.share >= 0.8 ? " is-near" : ""}`}>
                <span className="budget-bar-label">
                  {b.kind === "daily" ? "Today" : "Last 7 days"}: {money(b.spent)} of {money(b.budget)}
                </span>
                <span className="pbar-track" aria-hidden>
                  <span className="pbar-fill" style={{ width: `${Math.min(100, b.share * 100)}%` }} />
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function Tiles({ summary, days }: { summary: UsageSummary; days: number }) {
  const b = summary.block;
  return (
    <div className="tiles">
      <div className="tile">
        <span className="tile-label">Current 5-hour window</span>
        <span className="tile-value">{b ? money(b.cost) : "Idle"}</span>
        <span className="tile-note">
          {b ? `started ${clock(b.start)}, resets ${clock(b.end)}` : "starts with your next message"}
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">Today</span>
        <span className="tile-value">{money(summary.today.cost)}</span>
        <span className="tile-note">{compact(summary.today.tokens)} tokens</span>
      </div>
      {days > 1 && (
        <div className="tile">
          <span className="tile-label">Last {days} days</span>
          <span className="tile-value">{money(summary.range.cost)}</span>
          <span className="tile-note">
            {compact(summary.range.tokens)} tokens, {money(summary.range.cost / days)}/day
          </span>
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars: one hue, since rank already carries identity. */
function ProjectBars({
  rows,
  total,
  selected,
  onSelect,
}: {
  rows: ProjectRow[];
  total: number;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  if (!rows.length) return <p className="usage-empty">No usage in this range.</p>;
  const max = rows[0].cost || 1;
  const shown = rows.slice(0, 8);
  const rest = rows.slice(8);
  const restCost = rest.reduce((n, r) => n + r.cost, 0);
  return (
    <ul className="pbars">
      {shown.map((r) => (
        <li key={r.key}>
          <button
            className={`pbar${selected === r.key ? " is-selected" : ""}`}
            onClick={() => onSelect(r.key)}
            aria-pressed={selected === r.key}
            title={`${r.label}: ${money(r.cost)}, ${compact(r.tokens)} tokens, ${r.responses} responses${r.project ? "" : " (outside nebula)"}`}
          >
            <span className="pbar-label">
              {r.label}
              {!r.project && <span className="pbar-tag">not in nebula</span>}
            </span>
            <span className="pbar-value">
              {money(r.cost)}
              <span className="pbar-share">{total ? Math.round((r.cost / total) * 100) : 0}%</span>
            </span>
            <span className="pbar-track" aria-hidden>
              <span className="pbar-fill" style={{ width: `${Math.max(1.5, (r.cost / max) * 100)}%` }} />
            </span>
          </button>
        </li>
      ))}
      {rest.length > 0 && (
        <li className="pbar-rest">
          {rest.length} more, {money(restCost)}
        </li>
      )}
    </ul>
  );
}

/** Spend per day. A hover (or focus) on a bar shows its numbers. */
function DailyBars({ daily }: { daily: UsageSummary["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...daily.map((d) => d.cost), 0.01);
  const fmt = (day: number) =>
    new Date(day * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const shown = hover !== null ? daily[hover] : daily[daily.length - 1];

  return (
    <div className="dbars-wrap">
      <p className="dbars-readout" aria-live="polite">
        <span className="dbars-day">{hover !== null ? fmt(shown.day) : "Today"}</span>
        <span className="dbars-val">{money(shown.cost)}</span>
        <span className="dbars-tok">{compact(shown.tokens)} tokens</span>
      </p>
      <div className="dbars" role="list" onMouseLeave={() => setHover(null)}>
        {daily.map((d, i) => (
          <div
            key={d.day}
            role="listitem"
            tabIndex={0}
            className={`dbar${hover === i ? " is-hover" : ""}`}
            aria-label={`${fmt(d.day)}: ${money(d.cost)}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <span className="dbar-fill" style={{ height: `${d.cost ? Math.max(2, (d.cost / max) * 100) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="dbars-axis" aria-hidden>
        <span>{new Date(daily[0].day * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function TaskTable({ summary }: { summary: UsageSummary }) {
  const rows = summary.tasks.slice(0, 12);
  if (!rows.length) return <p className="usage-empty">No tasks in this range.</p>;
  return (
    <table className="task-table">
      <thead>
        <tr>
          <th scope="col">Task</th>
          <th scope="col">Where</th>
          <th scope="col">Model</th>
          <th scope="col" className="num">Tokens</th>
          <th scope="col" className="num">Spend</th>
          <th scope="col" className="num">Last</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.key}>
            <td>
              {t.agent ? (
                <button
                  className="link-btn task-link"
                  onClick={() => {
                    const agent = t.agent!;
                    setState((s) => ({
                      view: "sessions",
                      selectedProject: s.worktrees[agent.worktree_id]?.project_id ?? s.selectedProject,
                      selectedSession: { Agent: agent.id },
                    }));
                  }}
                >
                  {t.label}
                </button>
              ) : (
                <span className="task-plain" title={t.key}>
                  {t.label}
                </span>
              )}
            </td>
            <td className="task-where">{t.where}</td>
            <td className="task-model">{t.models.map((m) => m.replace(/^claude-/, "")).join(", ")}</td>
            <td className="num">{compact(t.tokens)}</td>
            <td className="num">{money(t.cost)}</td>
            <td className="num task-last">{relativeTime(t.last * 1000 + 3_600_000)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The sidebar's one-line readout; opens the full view. */
export function UsageChip() {
  const state = useAppState();
  const block = useMemo(
    () => (state.usage ? summarize(state.usage, state, { days: 1 }).block : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.usage, state.minute],
  );
  const on = state.view === "usage";
  const budget = useMemo(
    () => budgets(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.usage, state.prefs, state.minute],
  );
  const level = budgetLevel(budget);
  const worst = budget.reduce<(typeof budget)[number] | null>((w, b) => (!w || b.share > w.share ? b : w), null);
  return (
    <button
      className={`usage-chip${on ? " is-on" : ""}${level ? ` is-${level}` : ""}`}
      onClick={() => setState({ view: on ? "sessions" : "usage" })}
      aria-pressed={on}
      title="Claude usage (⌘U)"
    >
      <span className="usage-chip-label">Usage</span>
      <span className="usage-chip-value">
        {level && worst
          ? `${Math.round(worst.share * 100)}% of ${worst.kind} budget`
          : block
            ? `${money(block.cost)} this window`
            : state.usage
              ? "No active window"
              : "…"}
      </span>
      <kbd>⌘U</kbd>
    </button>
  );
}
