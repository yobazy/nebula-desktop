import { useMemo, useRef, useState } from "react";
import { useOverlayKeys } from "./Overlay";
import { budgetLevel, budgets } from "../nebula/budget";
import { savePrefs } from "../nebula/theme";
import { setState, useAppState } from "../nebula/store";
import { KIND_LABEL, relativeTime } from "../nebula/status";
import {
  compact,
  money,
  refreshUsage,
  summarize,
  type ProjectRow,
  type UsageSummary,
  type UsageReport,
} from "../nebula/usage";

import type { AgentKind } from "../nebula/types";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

/** Known costs and token usage across local agent histories. */
function spend(t: { cost: number; unpricedTokens: number }): string {
  return t.unpricedTokens ? (t.cost ? `${money(t.cost)}+` : "Unpriced") : money(t.cost);
}

export function UsageView() {
  const state = useAppState();
  const [days, setDays] = useState<number>(7);
  const [project, setProject] = useState<string | null>(null);
  const [source, setSource] = useState<AgentKind | null>(null);
  const report = state.usage;
  const controls = useRef<HTMLDivElement>(null);
  useOverlayKeys(controls);
  const summary = useMemo(
    () => (report ? summarize(report, state, { days, project, source }) : null),
    // Worktrees and agents decide attribution, and the minute when a window
    // has run out; git polls and the like don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, state.worktrees, state.agents, state.projects, state.minute, days, project, source],
  );
  const selectedSource = report?.sources.find((s) => s.source === source);
  const unavailable = selectedSource && selectedSource.status !== "available" && !summary?.range.tokens;
  const filtered = project ? summary?.projects.find((p) => p.key === project)?.label : null;

  return (
    <section className="usage" aria-labelledby="usage-title">
      <header className="usage-head" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <h1 id="usage-title">Agent usage</h1>
          <p className="usage-sub">
            Token usage across local agents, with recorded costs or standard API estimates.
            Subscription charges and plan limits are separate.
          </p>
        </div>
        <div className="usage-controls" ref={controls}>
          <select
            aria-label="Filter usage by agent"
            value={source ?? ""}
            onChange={(e) => {
              setSource((e.target.value || null) as AgentKind | null);
              setProject(null);
            }}
          >
            <option value="">All agents</option>
            {Object.entries(KIND_LABEL).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
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
          {state.usageError ? `Couldn't read usage: ${state.usageError}` : "Reading local agent usage…"}
        </p>
      ) : (
        <div className="usage-body">
          {state.usageError && <p className="usage-empty" role="alert">Refresh failed: {state.usageError}. Showing the last report.</p>}
          {unavailable ? (
            <p className="usage-empty">
              {KIND_LABEL[selectedSource.source]}: {selectedSource.status === "unsupported"
                ? "usage collection is not supported yet."
                : selectedSource.status === "error"
                  ? "the local usage source could not be read."
                  : "no local history was found."}
            </p>
          ) : <Tiles summary={summary} days={days} />}
          {summary.range.unpricedTokens > 0 && (
            <p className="usage-note">
              {compact(summary.range.unpricedTokens)} tokens have no known price.
              Cost totals and budgets exclude them; + marks partial costs.
            </p>
          )}
          {report && (
            <SourceCoverage report={report} days={days} selected={source} onSelect={(kind) => {
              setSource(source === kind ? null : kind);
              setProject(null);
            }} />
          )}
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
                total={summary.projects.reduce((sum, p) => sum + p.cost, 0)}
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
              {report.files} local history files/databases scanned. Estimates use standard model rates;
              service tiers, long-context premiums, and provider-specific charges may differ.
              Check each provider’s dashboard for billing and plan limits.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SourceCoverage({ report, days, selected, onSelect }: {
  report: UsageReport; days: number; selected: AgentKind | null; onSelect: (source: AgentKind) => void;
}) {
  const state = useAppState();
  const totals = useMemo(
    () => new Map(report.sources.map((s) => [s.source, summarize(report, state, { days, source: s.source }).range])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, state.worktrees, state.agents, state.projects, state.minute, days],
  );
  return (
    <section className="usage-card" aria-labelledby="usage-sources-title">
      <header className="usage-card-head">
        <h2 id="usage-sources-title">By agent</h2>
        <span className="usage-note">collection status · all projects</span>
      </header>
      <div className="usage-sources">
        {report.sources.map((s) => {
          const total = totals.get(s.source)!;
          const status = s.status === "unsupported" ? "Not supported yet"
            : s.status === "error" ? "Couldn’t read source"
              : s.status === "empty" ? "No local history found"
                : total.tokens ? `${compact(total.tokens)} tokens` : "No usage in this range";
          const unavailable = s.status !== "available" && !total.tokens;
          return (
            <button
              key={s.source}
              className={`usage-source${selected === s.source ? " is-selected" : ""}`}
              aria-pressed={selected === s.source}
              onClick={() => onSelect(s.source)}
              title={[s.detail, ...s.roots].filter(Boolean).join("\n")}
            >
              <span className="usage-source-name">{KIND_LABEL[s.source]}</span>
              <span className="usage-source-cost">{unavailable ? "—" : spend(total)}</span>
              <span className="usage-source-status">{status}</span>
            </button>
          );
        })}
      </div>
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
        <span className="usage-note">all agents · known costs only</span>
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
        <span className="tile-label">Recent activity · all projects</span>
        <span className="tile-value">{b ? spend(b) : "$0"}</span>
        <span className="tile-note">
          current hour and previous 4 hours
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">Today</span>
        <span className="tile-value">{spend(summary.today)}</span>
        <span className="tile-note">{compact(summary.today.tokens)} tokens</span>
      </div>
      {days > 1 && (
        <div className="tile">
          <span className="tile-label">Last {days} days</span>
          <span className="tile-value">{spend(summary.range)}</span>
          <span className="tile-note">
            {compact(summary.range.tokens)} tokens
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
  const tokenMode = total === 0 && rows.some((r) => r.tokens > 0);
  const amount = (r: ProjectRow) => tokenMode ? r.tokens : r.cost;
  const max = Math.max(...rows.map(amount), 1);
  const denominator = tokenMode ? rows.reduce((n, r) => n + r.tokens, 0) : total;
  const shown = rows.slice(0, 8);
  const rest = rows.slice(8);
  const restCost = rest.reduce((t, r) => ({ cost: t.cost + r.cost, unpricedTokens: t.unpricedTokens + r.unpricedTokens }), { cost: 0, unpricedTokens: 0 });
  return (
    <ul className="pbars" aria-label={tokenMode ? "Projects by tokens" : "Projects by known cost"}>
      {shown.map((r) => (
        <li key={r.key}>
          <button
            className={`pbar${selected === r.key ? " is-selected" : ""}`}
            onClick={() => onSelect(r.key)}
            aria-pressed={selected === r.key}
            title={`${r.label}: ${spend(r)}, ${compact(r.tokens)} tokens, ${r.responses} responses${r.project ? "" : " (outside nebula)"}`}
          >
            <span className="pbar-label">
              {r.label}
              {!r.project && <span className="pbar-tag">not in nebula</span>}
            </span>
            <span className="pbar-value">
              {spend(r)}
              <span className="pbar-share">{denominator ? Math.round((amount(r) / denominator) * 100) : 0}%{tokenMode ? " tokens" : ""}</span>
            </span>
            <span className="pbar-track" aria-hidden>
              <span className="pbar-fill" style={{ width: `${Math.max(1.5, (amount(r) / max) * 100)}%` }} />
            </span>
          </button>
        </li>
      ))}
      {rest.length > 0 && (
        <li className="pbar-rest">
          {rest.length} more, {spend(restCost)}
        </li>
      )}
    </ul>
  );
}

/** Spend per day. A hover (or focus) on a bar shows its numbers. */
function DailyBars({ daily }: { daily: UsageSummary["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const tokenMode = daily.every((d) => d.cost === 0) && daily.some((d) => d.tokens > 0);
  const amount = (d: UsageSummary["daily"][number]) => tokenMode ? d.tokens : d.cost;
  const max = Math.max(...daily.map(amount), 0.01);
  const fmt = (day: number) =>
    new Date(day * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const shown = hover !== null ? daily[hover] : daily[daily.length - 1];

  return (
    <div className="dbars-wrap">
      <p className="dbars-readout" aria-live="polite">
        <span className="dbars-day">{hover !== null ? fmt(shown.day) : "Today"}</span>
        <span className="dbars-val">{spend(shown)}</span>
        <span className="dbars-tok">{compact(shown.tokens)} tokens</span>
      </p>
      <div className="dbars" role="list" aria-label={tokenMode ? "Daily tokens" : "Daily known cost"} onMouseLeave={() => setHover(null)}>
        {daily.map((d, i) => (
          <div
            key={d.day}
            role="listitem"
            tabIndex={0}
            className={`dbar${hover === i ? " is-hover" : ""}`}
            aria-label={`${fmt(d.day)}: ${spend(d)}, ${compact(d.tokens)} tokens`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <span className="dbar-fill" style={{ height: `${amount(d) ? Math.max(2, (amount(d) / max) * 100) : 0}%` }} />
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
          <th scope="col">Agent / model</th>
          <th scope="col" className="num">Tokens</th>
          <th scope="col" className="num">Est. cost</th>
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
            <td className="task-model"><span className="task-agent">{KIND_LABEL[t.source]}</span>{t.models.map((m) => m.replace(/^claude-/, "")).join(", ")}</td>
            <td className="num">{compact(t.tokens)}</td>
            <td className="num">{spend(t)}</td>
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
  const today = useMemo(
    () => (state.usage ? summarize(state.usage, state, { days: 1 }).today : null),
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
      title="Agent usage (⌘U)"
    >
      <span className="usage-chip-label">Usage</span>
      <span className="usage-chip-value">
        {level && worst
          ? `${Math.round(worst.share * 100)}% of ${worst.kind} budget`
          : today
            ? `${spend(today)} today`
            : state.usage
              ? "No usage today"
              : "…"}
      </span>
      <kbd>⌘U</kbd>
    </button>
  );
}
