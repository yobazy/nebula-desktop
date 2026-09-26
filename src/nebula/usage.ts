// Claude usage, from Claude Code's session logs (read by `usage.rs`), cut by
// nebula project and task. Weighted as API-equivalent dollars: a subscription's
// limits track cost far better than raw tokens, where a million cache reads
// cost a small fraction of a million output tokens. Your plan's actual cap
// isn't recorded anywhere local, so the app shows spend, not "% of limit".
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview } from "./client";
import { getState, setState, type State } from "./store";
import type { Agent, Project, Worktree } from "./types";

export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface UsageBucket extends Tokens {
  /** Unix seconds, top of the hour. */
  hour: number;
  session: string;
  cwd: string;
  model: string;
  responses: number;
}

export interface UsageReport {
  root: string;
  files: number;
  buckets: UsageBucket[];
}

// ---- pricing ----

/** $ per million tokens: input, output, and cache reads as a fraction of
 *  input. Cache writes are 1.25x input (5-minute) and 2x (1-hour) on every
 *  model. Longest matching prefix wins, so dated ids (…-20251001) match too. */
const PRICES: [prefix: string, input: number, output: number, read: number][] = [
  ["claude-fable-5-1", 10, 50, 0.025],
  ["claude-mythos-5-1", 10, 50, 0.025],
  ["claude-fable-5", 10, 50, 0.1],
  ["claude-mythos-5", 10, 50, 0.1],
  ["claude-opus-5-5", 4, 20, 0.05],
  ["claude-opus-5", 5, 25, 0.1],
  ["claude-opus-4-8", 5, 25, 0.1],
  ["claude-opus-4-7", 5, 25, 0.1],
  ["claude-opus-4-6", 5, 25, 0.1],
  ["claude-sonnet-5", 2, 10, 0.1],
  ["claude-sonnet-4-6", 3, 15, 0.1],
  ["claude-haiku-4-5", 1, 5, 0.1],
  // Families, for ids newer or older than the table.
  ["claude-fable", 10, 50, 0.1],
  ["claude-mythos", 10, 50, 0.1],
  ["claude-opus", 5, 25, 0.1],
  ["claude-sonnet", 3, 15, 0.1],
  ["claude-haiku", 1, 5, 0.1],
  ["claude", 5, 25, 0.1],
];

function priceOf(model: string) {
  let best: (typeof PRICES)[number] | null = null;
  for (const p of PRICES) {
    if (model.startsWith(p[0]) && (!best || p[0].length > best[0].length)) best = p;
  }
  return best ?? PRICES[PRICES.length - 1];
}

export function costOf(t: Tokens, model: string): number {
  const [, input, output, read] = priceOf(model);
  return (
    (t.input * input +
      t.output * output +
      t.cacheWrite5m * input * 1.25 +
      t.cacheWrite1h * input * 2 +
      t.cacheRead * input * read) /
    1_000_000
  );
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
}

// ---- attribution ----

export interface Tally {
  cost: number;
  tokens: number;
  output: number;
  responses: number;
  /** Unix seconds of the latest hour with usage. */
  last: number;
}

const zero = (): Tally => ({ cost: 0, tokens: 0, output: 0, responses: 0, last: 0 });

function addTo(t: Tally, b: UsageBucket, cost: number) {
  t.cost += cost;
  t.tokens += totalTokens(b);
  t.output += b.output;
  t.responses += b.responses;
  t.last = Math.max(t.last, b.hour);
}

export interface ProjectRow extends Tally {
  key: string;
  label: string;
  project: Project | null;
}

export interface TaskRow extends Tally {
  key: string;
  label: string;
  where: string;
  agent: Agent | null;
  models: string[];
}

export interface Block {
  /** Unix seconds. */
  start: number;
  end: number;
  cost: number;
  tokens: number;
}

export interface UsageSummary {
  block: Block | null;
  today: Tally;
  range: Tally;
  projects: ProjectRow[];
  tasks: TaskRow[];
  /** One entry per day, oldest first, ending today (local time). */
  daily: { day: number; cost: number; tokens: number }[];
}

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

const within = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(dir + "/");

/** Which worktree and project a log's cwd and session belong to. A worktree
 *  deleted since (a merged task's, typically) is gone from the store, so the
 *  session's agent speaks for it next, then the project whose repo holds it. */
function locator(s: State) {
  const trees = Object.values(s.worktrees).sort((a, b) => b.path.length - a.path.length);
  const repos = Object.values(s.projects).sort((a, b) => b.repo_path.length - a.repo_path.length);
  const agents = new Map<string, Agent>();
  for (const a of Object.values(s.agents)) if (a.session_id) agents.set(a.session_id, a);
  const cache = new Map<string, Worktree | null>();
  const worktreeAt = (cwd: string) => {
    if (!cache.has(cwd)) cache.set(cwd, trees.find((w) => within(cwd, w.path)) ?? null);
    return cache.get(cwd)!;
  };
  const place = (cwd: string, session: string): { wt: Worktree | null; project: Project | null } => {
    const agent = agents.get(session);
    const wt = worktreeAt(cwd) ?? (agent ? (s.worktrees[agent.worktree_id] ?? null) : null);
    if (wt) return { wt, project: s.projects[wt.project_id] ?? null };
    return { wt: null, project: repos.find((p) => within(cwd, p.repo_path)) ?? null };
  };
  return { place, agents };
}

const BLOCK_S = 5 * 3600;

/** Claude's usage windows run five hours from the first message after the
 *  last one ended. Hour buckets place the start to the hour, as ccusage does.
 *  The chain starts after the latest quiet spell of five hours or more — a
 *  window certainly began there — so its boundaries don't slide with the
 *  30 days of history the report happens to reach back to. */
function currentBlock(buckets: UsageBucket[], now: number): Block | null {
  let from = 0;
  for (let i = buckets.length - 1; i > 0; i--) {
    if (buckets[i].hour - buckets[i - 1].hour >= BLOCK_S) {
      from = i;
      break;
    }
  }
  let block: Block | null = null;
  for (const b of buckets.slice(from)) {
    if (!block || b.hour >= block.end) {
      block = { start: b.hour, end: b.hour + BLOCK_S, cost: 0, tokens: 0 };
    }
    block.cost += costOf(b, b.model);
    block.tokens += totalTokens(b);
  }
  return block && now < block.end ? block : null;
}

function startOfDay(t: number): number {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Local midnight `n` calendar days before the day holding `t` — by the
 *  calendar, not 86,400-second steps, which drift an hour across DST. */
function daysBefore(t: number, n: number): number {
  const d = new Date(startOfDay(t) * 1000);
  d.setDate(d.getDate() - n);
  return Math.floor(d.getTime() / 1000);
}

export function summarize(
  report: UsageReport,
  s: State,
  opts: { days: number; project?: string | null; now?: number },
): UsageSummary {
  const now = opts.now ?? Date.now() / 1000;
  const since = daysBefore(now, opts.days - 1);
  const today = startOfDay(now);
  const { place, agents } = locator(s);

  const projects = new Map<string, ProjectRow>();
  const tasks = new Map<string, TaskRow>();
  const range = zero();
  const todayT = zero();
  const dailyDays = 14;
  const dailyFrom = daysBefore(now, dailyDays - 1);
  const daily = new Map<number, { cost: number; tokens: number }>();

  for (const b of report.buckets) {
    const cost = costOf(b, b.model);
    const day = startOfDay(b.hour);
    if (day >= dailyFrom) {
      const d = daily.get(day) ?? { cost: 0, tokens: 0 };
      d.cost += cost;
      d.tokens += totalTokens(b);
      daily.set(day, d);
    }
    if (b.hour + 3600 <= since) continue;

    const { wt, project } = place(b.cwd, b.session);
    const pKey = project ? project.id : `cwd:${b.cwd}`;

    // The project list always shows every project, so a filter picked from
    // it can be switched straight to another one.
    let p = projects.get(pKey);
    if (!p) {
      p = { ...zero(), key: pKey, label: project?.name ?? basename(b.cwd), project };
      projects.set(pKey, p);
    }
    addTo(p, b, cost);
    if (opts.project && pKey !== opts.project) continue;

    addTo(range, b, cost);
    if (b.hour >= today) addTo(todayT, b, cost);

    const agent = agents.get(b.session) ?? null;
    let t = tasks.get(b.session);
    if (!t) {
      const branch = wt && !wt.is_main ? ` · ${wt.branch}` : "";
      t = {
        ...zero(),
        key: b.session,
        label: agent?.name ?? `Session ${b.session.slice(0, 8)}`,
        where: `${project?.name ?? basename(b.cwd)}${branch}`,
        agent,
        models: [],
      };
      tasks.set(b.session, t);
    }
    addTo(t, b, cost);
    if (!t.models.includes(b.model)) t.models.push(b.model);
  }

  return {
    block: currentBlock(report.buckets, now),
    today: todayT,
    range,
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost),
    tasks: [...tasks.values()].sort((a, b) => b.cost - a.cost),
    daily: Array.from({ length: dailyDays }, (_, i) => {
      const day = daysBefore(now, dailyDays - 1 - i);
      return { day, ...(daily.get(day) ?? { cost: 0, tokens: 0 }) };
    }),
  };
}

// ---- formatting ----

export function money(n: number): string {
  if (n >= 100) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(2) === "0.00" ? "<0.01" : n.toFixed(2)}`;
  return "$0";
}

export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

// ---- loading ----

const DAYS = 30;
let loading = false;
/** Asked for mid-scan (a Refresh click): scan again once this one lands. */
let again = false;

export async function refreshUsage() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    const report = isPreview()
      ? (await import("./mock")).mockUsage()
      : await invoke<UsageReport>("usage_report", { days: DAYS });
    setState({ usage: report, usageError: null });
  } catch (e) {
    setState({ usageError: String(e) });
  } finally {
    loading = false;
  }
  if (again) {
    again = false;
    void refreshUsage();
  }
}

/** Mount once: keeps `state.usage` fresh — every minute while the usage view
 *  is open, every five otherwise (the sidebar shows the current window). */
export function useUsagePolling() {
  useEffect(() => {
    void refreshUsage();
    let last = Date.now();
    const t = setInterval(() => {
      if (document.hidden) return;
      const every = getState().view === "usage" ? 60_000 : 300_000;
      if (Date.now() - last >= every) {
        last = Date.now();
        void refreshUsage();
      }
    }, 15_000);
    return () => clearInterval(t);
  }, []);
}
