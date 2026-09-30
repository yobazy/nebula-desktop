// Pure usage accounting shared by the UI and regression tests.
import type { State } from "./store";
import type { Agent, AgentKind, Project, Worktree } from "./types";

export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface UsageBucket extends Tokens {
  source: AgentKind;
  recordedCost?: number | null;
  /** Unix seconds, top of the hour. */
  hour: number;
  session: string;
  cwd: string;
  model: string;
  responses: number;
}

export interface UsageReport {
  sources: UsageSource[];
  files: number;
  buckets: UsageBucket[];
}

export interface UsageSource {
  source: AgentKind;
  roots: string[];
  files: number;
  status: "available" | "empty" | "error" | "unsupported";
  detail?: string | null;
}

export const sessionKey = (source: AgentKind, session: string) => `${source}:${session}`;

// ---- pricing ----

/** $ per million tokens: input, output, and cache reads as a fraction of
 *  input. Cache writes are 1.25x input (5-minute) and 2x (1-hour) on every
 *  model. Only explicit model names and their dated snapshots match. */
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
  // Explicit family aliases; unrecognized model versions remain unpriced.
  ["claude-fable", 10, 50, 0.1],
  ["claude-mythos", 10, 50, 0.1],
  ["claude-opus", 5, 25, 0.1],
  ["claude-sonnet", 3, 15, 0.1],
  ["claude-haiku", 1, 5, 0.1],
  // Standard API estimates, verified 2026-09-29:
  // https://developers.openai.com/api/docs/pricing
  ["gpt-5.5", 5, 30, 0.1],
  ["gpt-5.6-terra", 2, 12, 0.1],
  ["gpt-5.6-luna", 0.2, 1.2, 0.1],
  ["gpt-5.6-sol", 4, 20, 0.1],
  ["gpt-5.6", 4, 20, 0.1],
  ["gpt-6-astra", 10, 50, 0.1],
  ["gpt-6-sol", 2, 10, 0.1],
  ["gpt-6-luna", 0.1, 0.5, 0.1],
];

function priceOf(model: string) {
  const base = model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  return PRICES.find(([name]) => name === base) ?? null;
}

export function costOf(t: Tokens & { recordedCost?: number | null }, model: string): number | null {
  if (t.recordedCost != null && Number.isFinite(t.recordedCost) && t.recordedCost >= 0) return t.recordedCost;
  const price = priceOf(model);
  if (!price) return null;
  const [, input, output, read] = price;
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
  unpricedTokens: number;
  tokens: number;
  output: number;
  responses: number;
  /** Unix seconds of the latest hour with usage. */
  last: number;
}

const zero = (): Tally => ({ cost: 0, unpricedTokens: 0, tokens: 0, output: 0, responses: 0, last: 0 });

function addTo(t: Tally, b: UsageBucket, cost: number | null) {
  t.cost += cost ?? 0;
  if (cost === null) t.unpricedTokens += totalTokens(b);
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
  source: AgentKind;
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
  unpricedTokens: number;
  tokens: number;
}

export interface UsageSummary {
  block: Block | null;
  today: Tally;
  range: Tally;
  projects: ProjectRow[];
  tasks: TaskRow[];
  /** One entry per day, oldest first, ending today (local time). */
  daily: { day: number; cost: number; tokens: number; unpricedTokens: number }[];
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
  for (const a of Object.values(s.agents)) if (a.session_id) agents.set(sessionKey(a.kind, a.session_id), a);
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

/** Rolling five-hour activity estimate; never a provider quota/reset window.
 * Hour buckets include the current hour and the four preceding hours. */
function currentBlock(buckets: UsageBucket[], now: number): Block | null {
  const start = Math.floor(now / 3600) * 3600 - 4 * 3600;
  const block: Block = { start, end: now, cost: 0, tokens: 0, unpricedTokens: 0 };
  for (const b of buckets) {
    if (b.hour < start || b.hour > now) continue;
    const cost = costOf(b, b.model);
    block.cost += cost ?? 0;
    block.tokens += totalTokens(b);
    if (cost === null) block.unpricedTokens += totalTokens(b);
  }
  return block.tokens ? block : null;
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
  opts: { days: number; project?: string | null; source?: AgentKind | null; now?: number },
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
  const daily = new Map<number, { cost: number; tokens: number; unpricedTokens: number }>();

  const buckets = report.buckets.filter((b) => (!opts.source || b.source === opts.source) && b.hour <= now);
  for (const b of buckets) {
    const cost = costOf(b, b.model);
    const day = startOfDay(b.hour);
    if (day >= dailyFrom) {
      const d = daily.get(day) ?? { cost: 0, tokens: 0, unpricedTokens: 0 };
      d.cost += cost ?? 0;
      if (cost === null) d.unpricedTokens += totalTokens(b);
      d.tokens += totalTokens(b);
      daily.set(day, d);
    }
    if (b.hour + 3600 <= since) continue;

    const { wt, project } = place(b.cwd, sessionKey(b.source, b.session));
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

    const agent = agents.get(sessionKey(b.source, b.session)) ?? null;
    const key = sessionKey(b.source, b.session);
    let t = tasks.get(key);
    if (!t) {
      const branch = wt && !wt.is_main ? ` · ${wt.branch}` : "";
      t = {
        ...zero(),
        key,
        source: b.source,
        label: agent?.name ?? `Session ${b.session.slice(0, 8)}`,
        where: `${project?.name ?? basename(b.cwd)}${branch}`,
        agent,
        models: [],
      };
      tasks.set(key, t);
    }
    addTo(t, b, cost);
    if (!t.models.includes(b.model)) t.models.push(b.model);
  }

  return {
    block: currentBlock(buckets, now),
    today: todayT,
    range,
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    tasks: [...tasks.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    daily: Array.from({ length: dailyDays }, (_, i) => {
      const day = daysBefore(now, dailyDays - 1 - i);
      return { day, ...(daily.get(day) ?? { cost: 0, tokens: 0, unpricedTokens: 0 }) };
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

