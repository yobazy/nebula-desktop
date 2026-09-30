// Browser preview (`npm run dev` outside Tauri): demo projects and a canned
// terminal, so the UI can be styled without a daemon. Never loaded in the app.
import { byId, getState, setState } from "./store";
import type { GitStatus } from "./git";
import type { UsageBucket, UsageReport } from "./usage";
import type { Agent, AgentStatus, EntityId, Project, SessionRef, Worktree } from "./types";

const now = Date.now();
const min = 60_000;

// A made-up team's work: a web shop and the projects around it.
const HOME = "/Users/dev/code";

const projects: Project[] = [
  "storefront",
  "marketing-site",
  "admin-dashboard",
  "mobile-app",
  "billing-api",
  "design-system",
  "data-pipeline",
].map((name, i) => ({
  id: `p${i}`,
  name,
  repo_path: `${HOME}/${name}`,
  sort_order: i,
}));

const worktrees: Worktree[] = [
  { id: "w0", project_id: "p0", path: `${HOME}/storefront`, branch: "main", is_main: true, sort_order: 0 },
  { id: "w1", project_id: "p0", path: `${HOME}/storefront-worktrees/cart-sync`, branch: "cart-sync", is_main: false, sort_order: 1 },
  { id: "w2", project_id: "p0", path: `${HOME}/storefront-worktrees/stripe-webhooks`, branch: "stripe-webhooks", is_main: false, sort_order: 2 },
  { id: "w3", project_id: "p0", path: `${HOME}/storefront-worktrees/search-facets`, branch: "search-facets", is_main: false, sort_order: 3 },
  ...projects.slice(1).map((p, i) => ({
    id: `wm${i}`,
    project_id: p.id,
    path: p.repo_path,
    branch: "main",
    is_main: true,
    sort_order: 0,
  })),
];

function agent(
  id: string,
  worktree_id: string,
  name: string,
  status: AgentStatus,
  ago: number,
  prompts: string[],
  extra: Partial<Agent> = {},
): Agent {
  return {
    id,
    worktree_id,
    name,
    status,
    archived: false,
    archived_at: 0,
    unseen: false,
    status_changed_at: now - ago * min,
    kind: "claude",
    custom_harness: null,
    model: "opus",
    effort: null,
    session_id: `s-${id}`,
    cloud_session_id: null,
    issue_url: null,
    sort_order: 0,
    alive: true,
    recent_prompts: prompts.map((text, i) => ({ text, submitted_at: now - (ago + i) * min })),
    ...extra,
  };
}

const agents: Agent[] = [
  agent("a1", "w0", "Search Synonyms", "running", 1, ["why does search ignore synonyms like tee and t-shirt?"]),
  agent("a2", "w1", "Sequential Cart Sync", "needs_feedback", 4, ["make cart sync apply one update at a time"]),
  agent("a3", "w1", "Sync Retry Backoff", "finished", 12, ["add exponential backoff when a cart sync fails"], { unseen: true }),
  agent("a4", "w2", "Invoice Webhooks", "running", 2, ["handle invoice.paid webhooks idempotently"], { kind: "codex", model: "gpt-5.5" }),
  agent("a5", "w0", "Product URL Slugs", "finished", 95, ["accept unicode product names in URL slugs"]),
  agent("a6", "wm0", "Hero Section Redesign", "needs_feedback", 9, ["rework the hero so the pricing grid leads"]),
  agent("a7", "wm0", "Lighthouse Fixes", "finished", 60 * 26, ["get lighthouse perf above 95"]),
  agent("a8", "wm1", "Orders Command Menu", "finished", 60 * 3, ["add a cmd+k menu for orders"], { unseen: true }),
  agent("a9", "wm2", "Share Sheet", "fresh", 0, []),
  agent("a10", "wm3", "Weekly Invoice Job", "terminated", 45, ["generate the weekly invoice batch"]),
  agent("a12", "w3", "Search Facets", "finished", 60 * 5, ["add size and color facets to search"]),
  agent("a11", "w0", "Old Spike", "finished", 60 * 24 * 6, ["spike on an image CDN"], { archived: true }),
];

const DEMO = [
  "\x1b[38;5;111m╭──────────────────────────────────────────────╮\x1b[0m",
  "\x1b[38;5;111m│\x1b[0m \x1b[1m✻ Claude Code\x1b[0m                                 \x1b[38;5;111m│\x1b[0m",
  `\x1b[38;5;111m│\x1b[0m   cwd: ${"~/code/storefront".padEnd(38)} \x1b[38;5;111m│\x1b[0m`,
  "\x1b[38;5;111m╰──────────────────────────────────────────────╯\x1b[0m",
  "",
  "\x1b[38;5;244m>\x1b[0m make cart sync apply one update at a time",
  "",
  "\x1b[38;5;215m●\x1b[0m I'll read the sync module first.",
  "",
  "  \x1b[1mRead\x1b[0m(src/cart/sync.ts)",
  "  \x1b[38;5;244m⎿  Read 168 lines\x1b[0m",
  "",
  "\x1b[38;5;215m●\x1b[0m Sync applies every update with Promise.all, so they race.",
  "  I'll switch it to a worker that applies the next update",
  "  when the current one settles.",
  "",
  "  \x1b[1mUpdate\x1b[0m(src/cart/sync.ts)",
  "  \x1b[32m+  for (const update of pending) {\x1b[0m",
  "  \x1b[32m+    await this.apply(update);\x1b[0m",
  "  \x1b[31m-  await Promise.all(pending.map((u) => this.apply(u)));\x1b[0m",
  "",
  "\x1b[48;5;236m Do you want to make this edit to sync.ts?                  \x1b[0m",
  "\x1b[48;5;236m \x1b[38;5;111m❯ 1. Yes\x1b[0m\x1b[48;5;236m                                                  \x1b[0m",
  "\x1b[48;5;236m   2. Yes, and don't ask again this session                 \x1b[0m",
  "\x1b[48;5;236m   3. No, and tell Claude what to do differently (esc)      \x1b[0m",
  "",
].join("\r\n");

const c = (n: number, t: string) => `\x1b[38;5;${n}m${t}\x1b[0m`;
const bold = (t: string) => `\x1b[1m${t}\x1b[0m`;

/** Each session's own canned screen: its folder, its last prompt, and what
 *  an agent in its state shows — so switching sessions in the preview looks
 *  like switching sessions. The queue agent keeps the hand-written one. */
function screenFor(session: SessionRef): string {
  const s = getState();
  if ("Agent" in session && session.Agent === "a2") return DEMO;
  const tab = "Terminal" in session ? s.terminals[session.Terminal] : undefined;
  const agent = "Agent" in session ? s.agents[session.Agent] : undefined;
  const wt = s.worktrees[agent?.worktree_id ?? tab?.worktree_id ?? ""];
  const cwd = (wt?.path ?? "~").replace(/^\/Users\/[^/]+/, "~");
  if (tab) {
    const cmd = tab.run_command;
    return [
      `${c(111, cwd)} ${c(244, "❯")} ${cmd ?? ""}`,
      ...(cmd
        ? ["", `  ${c(36, "VITE")} v6.2.0  ready in ${bold("412")} ms`, "", `  ${c(114, "➜")}  ${bold("Local")}:   ${c(36, "http://localhost:5173/")}`, `  ${c(244, "➜  Network: use --host to expose")}`]
        : []),
      "",
    ].join("\r\n");
  }
  if (!agent) return "";
  const prompt = agent.recent_prompts[agent.recent_prompts.length - 1]?.text ?? "";
  const box = [
    c(111, "╭──────────────────────────────────────────────╮"),
    `${c(111, "│")} ${bold("✻ Claude Code")}                                 ${c(111, "│")}`,
    `${c(111, "│")}   cwd: ${cwd.padEnd(38).slice(0, 38)} ${c(111, "│")}`,
    c(111, "╰──────────────────────────────────────────────╯"),
    "",
  ];
  const topic = prompt.split(" ").slice(0, 4).join(" ");
  const body =
    agent.status === "needs_feedback"
      ? [
          `${c(215, "●")} I'll start with the layout, then the styles.`,
          "",
          `  ${bold("Update")}(src/components/Hero.tsx)`,
          `  ${c(114, "+  <PricingGrid featured />")}`,
          `  ${c(203, "-  <Banner title={site.title} />")}`,
          "",
          "\x1b[48;5;236m Do you want to make this edit to Hero.tsx?          \x1b[0m",
          `\x1b[48;5;236m ${c(111, "❯ 1. Yes")}\x1b[48;5;236m                                            \x1b[0m`,
          "\x1b[48;5;236m   2. Yes, and don't ask again this session           \x1b[0m",
          "\x1b[48;5;236m   3. No, and tell Claude what to do differently      \x1b[0m",
        ]
      : agent.status === "running"
        ? [
            `${c(215, "●")} Looking at how ${topic} fits in first.`,
            "",
            `  ${bold("Search")}(pattern: "export", path: "src")`,
            `  ${c(244, "⎿  Found 14 files")}`,
            `  ${bold("Read")}(src/index.ts)`,
            `  ${c(244, "⎿  Read 96 lines")}`,
            "",
            `${c(215, "✻")} ${c(215, "Working…")} ${c(244, "(38s · esc to interrupt)")}`,
          ]
        : agent.status === "finished"
          ? [
              `${c(215, "●")} Done: ${topic}.`,
              "",
              `  ${c(114, "✓")} Changes made and tests pass.`,
              `  ${c(114, "✓")} Ready to commit.`,
              "",
              `${c(244, ">")} `,
            ]
          : [`${c(244, ">")} `];
  return [...box, prompt ? `${c(244, ">")} ${prompt}` : "", "", ...body, ""].join("\r\n");
}

type PtyHandler = (
  chunk: { session: SessionRef; replay: boolean; seq: number; data: string },
  bytes: Uint8Array,
) => void;

export function startMock(handlers: Map<string, PtyHandler>) {
  setState({
    link: { state: "connected", daemonPid: 0 },
    loaded: true,
    projects: byId(projects),
    worktrees: byId(worktrees),
    agents: byId(agents),
    terminals: {},
    selectedProject: "p0",
    selectedSession: { Agent: "a2" },
    epoch: 1,
    snapshots: 1,
  });
  // Answer every attach with the canned screen.
  let runSeq = 0;
  return (variant: string, body: Record<string, unknown> | undefined): EntityId | { error: string } | null | void => {
    if (variant === "StartRun" && body) {
      const wt = worktrees.find((w) => w.id === body.worktree);
      // storefront has a run command; the rest show the setup dialog.
      if (!wt || wt.project_id !== "p0") {
        return { error: "no run command for this worktree — set one in Settings (s) → Project, or add .nebula.json with {\"run\": \"npm run dev\"}" };
      }
      const id = `run-${wt.id}`;
      const term = { id, worktree_id: wt.id, name: "run", sort_order: 0, alive: true, run_command: "npm run dev" };
      setState((s) => ({ terminals: { ...s.terminals, [id]: term } }));
      runSeq = 0;
      return { Terminal: id };
    }
    // Row menu requests, so the preview shows their effect.
    const agentId = body?.id as string | undefined;
    if (variant === "RenameAgent" && agentId) {
      setState((s) => ({ agents: { ...s.agents, [agentId]: { ...s.agents[agentId], name: String(body!.name) } } }));
      return null;
    }
    if ((variant === "ArchiveAgent" || variant === "UnarchiveAgent") && agentId) {
      const archived = variant === "ArchiveAgent";
      setState((s) => ({ agents: { ...s.agents, [agentId]: { ...s.agents[agentId], archived } } }));
      return null;
    }
    if (variant === "DeleteAgent" && agentId) {
      setState((s) => {
        const agents = { ...s.agents };
        delete agents[agentId];
        return { agents };
      });
      return null;
    }
    if (variant === "CreateWorktree" && body) {
      const id = `wf${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
      const project = getState().projects[String(body.project)];
      const wt: Worktree = {
        id,
        project_id: String(body.project),
        path: `${project?.repo_path ?? HOME}-worktrees/${body.branch}`,
        branch: String(body.branch),
        is_main: false,
        sort_order: 100,
      };
      worktrees.push(wt);
      setState((s) => ({ worktrees: { ...s.worktrees, [id]: wt } }));
      return { Worktree: id };
    }
    if (variant === "CreateAgent" && body) {
      const id = `af${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
      const prompt = body.starting_prompt ? [String(body.starting_prompt)] : [];
      const a = agent(id, String(body.worktree), String(body.name), "running", 0, prompt, { kind: body.kind as Agent["kind"] });
      setState((s) => ({ agents: { ...s.agents, [id]: { ...a, status_changed_at: Date.now() } } }));
      return { Agent: id };
    }
    if (variant === "DeleteWorktree" && body) {
      const id = String(body.id);
      setState((s) => {
        const worktrees = { ...s.worktrees };
        delete worktrees[id];
        const agents = Object.fromEntries(Object.entries(s.agents).filter(([, a]) => a.worktree_id !== id));
        return { worktrees, agents };
      });
      return null;
    }
    if (variant === "StopRun" && body) {
      setState((s) => {
        const terminals = { ...s.terminals };
        for (const t of Object.values(terminals)) if (t.worktree_id === body.worktree && t.run_command) delete terminals[t.id];
        return { terminals };
      });
      return null;
    }
    if (variant === "TailOutput" && body && "Agent" in (body.session as SessionRef)) {
      const text = screenFor(body.session as SessionRef);
      return { end_seq: text.length, data: new TextEncoder().encode(text) } as unknown as EntityId;
    }
    if (variant === "TailOutput" && body) {
      // A dev server that prints its address a moment after starting.
      runSeq += 1;
      const text = runSeq < 2 ? "\x1b[36m> vite\x1b[0m\r\n" : "\r\n  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[0m\r\n";
      return { end_seq: runSeq * 100, data: new TextEncoder().encode(text) } as unknown as EntityId;
    }
    if (variant === "AddProject" && body) {
      const repo_path = String(body.path);
      const project: Project = {
        id: `p${Date.now()}`,
        name: repo_path.split("/").pop() || repo_path,
        repo_path,
        sort_order: 1000,
      };
      setState((s) => ({ projects: { ...s.projects, [project.id]: project } }));
      return { Project: project.id };
    }
    if (variant !== "Attach" || !body) return;
    const session = body.session as SessionRef;
    const key = "Agent" in session ? `a:${session.Agent}` : `t:${session.Terminal}`;
    setTimeout(() => {
      const bytes = new TextEncoder().encode(screenFor(session));
      handlers.get(key)?.({ session, replay: true, seq: 0, data: "" }, bytes);
    }, 50);
  };
}

const clean = {
  branch: "main",
  head: "a1b2c3d",
  upstream: "origin/main",
  upstreamGone: false,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  insertions: 0,
  deletions: 0,
  baseAhead: null,
  lastCommit: { subject: "Initial commit", time: Math.round(now / 1000) - 86_400 },
};

/** A spread of git states: dirty, unpushed, never pushed, behind, clean. */
export function mockGitStatus(worktreeId: string): GitStatus {
  const wt = worktrees.find((w) => w.id === worktreeId);
  const base = { ...clean, branch: wt?.branch ?? "main" };
  switch (worktreeId) {
    case "w0":
      return { ...base, ahead: 2, lastCommit: { subject: "Accept unicode slugs", time: Math.round(now / 1000) - 3_600 } };
    case "w1":
      return { ...base, upstream: "origin/cart-sync", unstaged: 3, untracked: 1, insertions: 142, deletions: 37, baseAhead: 4 };
    case "w2":
      return { ...base, upstream: null, baseAhead: 3 };
    case "wm0":
      return { ...base, behind: 5 };
    case "w3":
      return { ...base, upstream: "origin/search-facets", upstreamGone: true, baseAhead: 2 };
    case "wm2":
      return { ...base, upstreamGone: true };
    case "wm1":
      return { ...base, staged: 2, unstaged: 2, insertions: 186, deletions: 24 };
    default:
      return base;
  }
}

/** A month of plausible usage: heavier on the busy projects, a few sessions
 *  from outside nebula, and a burst in the last couple of hours. */
export function mockUsage(): UsageReport {
  const hourNow = Math.floor(now / 3_600_000) * 3600;
  const cwdOf = (a: Agent) => worktrees.find((w) => w.id === a.worktree_id)?.path ?? "/tmp";
  const sessions: { session: string; cwd: string; model: string; source: Agent["kind"]; weight: number }[] = [
    ...agents.map((a, i) => ({
      session: `s-${a.id}`,
      cwd: cwdOf(a),
      source: a.kind,
      model: a.kind === "codex" ? "gpt-6-astra" : i % 3 === 0 ? "claude-fable-5-1" : "claude-opus-5-5",
      weight: [5, 9, 3, 6, 2, 7, 1, 4, 0.5, 1.5, 0.8][i] ?? 1,
    })),
    { source: "claude", session: "0f3a9c12-outside", cwd: "/Users/dev/scratch/notes", model: "claude-haiku-4-5", weight: 1 },
  ];
  // A deterministic wobble instead of Math.random, so the preview is stable.
  const wobble = (n: number) => ((Math.sin(n * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const buckets: UsageBucket[] = [];
  for (let h = 0; h < 30 * 24; h++) {
    const hour = hourNow - h * 3600;
    const local = new Date(hour * 1000).getHours();
    // Quiet overnight, except the last few hours so a 5-hour window is live.
    if (h >= 3 && (local < 8 || local > 23)) continue;
    sessions.forEach((s, i) => {
      const r = wobble(h * 31 + i);
      const recent = h < 3 ? 3 : 1;
      if (r > 0.18 * s.weight * recent) return;
      const scale = s.weight * (0.5 + r) * recent;
      buckets.push({
        hour,
        session: s.session,
        cwd: s.cwd,
        source: s.source,
        model: s.model,
        input: Math.round(400 * scale),
        output: Math.round(9_000 * scale),
        cacheWrite5m: 0,
        cacheWrite1h: s.source === "claude" ? Math.round(40_000 * scale) : 0,
        cacheRead: Math.round(600_000 * scale),
        responses: Math.round(12 * scale) + 1,
      });
    });
  }
  return { sources: [
    { source: "claude", roots: ["~/.claude/projects"], files: 36, status: "available" },
    { source: "codex", roots: ["~/.codex/sessions"], files: 6, status: "available" },
    { source: "pi", roots: ["~/.pi/agent/sessions"], files: 0, status: "empty" },
    { source: "open_code", roots: ["~/.local/share/opencode/opencode.db"], files: 0, status: "empty" },
    ...(["cursor", "muse", "grok", "custom"] as const).map((source) => ({ source, roots: [], files: 0, status: "unsupported" as const })),
  ], files: 42, buckets: buckets.sort((a, b) => a.hour - b.hour) };
}

/** A small change set per demo worktree, as git.rs would report it. */
export function mockDiff(worktreeId: string, scope: "uncommitted" | "branch") {
  const sync = [
    "diff --git a/src/cart/sync.ts b/src/cart/sync.ts",
    "index 3b18e51..a9d2c10 100644",
    "--- a/src/cart/sync.ts",
    "+++ b/src/cart/sync.ts",
    "@@ -12,14 +12,19 @@ export class CartSync {",
    "   private pending: CartUpdate[] = [];",
    "   private running = false;",
    " ",
    "-  async flush() {",
    "-    await Promise.all(this.pending.map((u) => this.apply(u)));",
    "-    this.pending = [];",
    "+  /** Apply queued updates one at a time, in the order they arrived. */",
    "+  async flush() {",
    "+    if (this.running) return;",
    "+    this.running = true;",
    "+    try {",
    "+      while (this.pending.length) {",
    "+        const update = this.pending.shift()!;",
    "+        await this.apply(update);",
    "+      }",
    "+    } finally {",
    "+      this.running = false;",
    "+    }",
    "   }",
    " ",
    "   private async apply(update: CartUpdate) {",
    "     const res = await fetch(`/api/cart/${update.id}`, {",
    "diff --git a/src/cart/sync.test.ts b/src/cart/sync.test.ts",
    "new file mode 100644",
    "index 0000000..5e1c309",
    "--- /dev/null",
    "+++ b/src/cart/sync.test.ts",
    "@@ -0,0 +1,9 @@",
    "+import { CartSync } from './sync';",
    "+",
    "+test('applies updates in order', async () => {",
    "+  const seen: number[] = [];",
    "+  const sync = new CartSync((u) => seen.push(u.id));",
    "+  sync.push({ id: 1 }, { id: 2 }, { id: 3 });",
    "+  await sync.flush();",
    "+  expect(seen).toEqual([1, 2, 3]);",
    "+});",
    "diff --git a/src/cart/legacy.ts b/src/cart/legacy.ts",
    "deleted file mode 100644",
    "index 77aa0f1..0000000",
    "--- a/src/cart/legacy.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-// Kept for the old checkout flow.",
    "-export const LEGACY_SYNC = true;",
    "-export default LEGACY_SYNC;",
    "",
  ].join("\n");
  const committed = [
    "diff --git a/src/cart/retry.ts b/src/cart/retry.ts",
    "index 1d2e3f4..5a6b7c8 100644",
    "--- a/src/cart/retry.ts",
    "+++ b/src/cart/retry.ts",
    "@@ -1,5 +1,8 @@",
    " export async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {",
    "-  return fn();",
    "+  for (let i = 0; ; i++) {",
    "+    try { return await fn(); }",
    "+    catch (e) { if (i + 1 >= tries) throw e; await sleep(2 ** i * 250); }",
    "+  }",
    " }",
    "",
  ].join("\n");
  const dirty = worktreeId === "w1" || worktreeId === "wm1";
  return {
    patch: (dirty ? sync : "") + (scope === "branch" && worktreeId !== "wm1" ? committed : ""),
    untracked: dirty ? [{ path: "notes/cart-sync.md", text: "# Cart sync\n\nOne update at a time.\n", size: 36 }] : [],
    truncated: false,
    against: scope === "branch" ? "3f9a2c1" : "HEAD",
  };
}

/** A spread of pull request states for the demo branches. */
export function mockPr(worktreeId: string) {
  const base = { url: "https://github.com/acme/storefront/pull/", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "" };
  switch (worktreeId) {
    case "w1":
      return {
        kind: "found" as const,
        pr: {
          ...base,
          number: 128,
          url: base.url + 128,
          title: "Apply cart updates sequentially",
          state: "OPEN",
          reviewDecision: "CHANGES_REQUESTED",
          statusCheckRollup: [
            { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
            { name: "e2e", status: "COMPLETED", conclusion: "FAILURE" },
          ],
        },
      };
    case "w2":
      return { kind: "none" as const };
    case "w3":
      return {
        kind: "found" as const,
        pr: { ...base, number: 121, url: base.url + 121, title: "Search facets", state: "MERGED", headRefOid: "a1b2c3d", reviewDecision: "APPROVED", statusCheckRollup: [] },
      };
    default:
      return { kind: "none" as const };
  }
}
