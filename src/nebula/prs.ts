// The pull request on each worktree's branch, from the GitHub CLI (gh.rs),
// polled like git state but slower: it's a network call. Checks are folded
// the way `gh pr checks` folds them, as the TUI does.
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview, onAgentStatus } from "./client";
import { getState, projectWorktrees, setState, subscribe } from "./store";
import type { Worktree } from "./types";

export type Checks = "none" | "passing" | "pending" | "failing";

export interface PullRequest {
  number: number;
  url: string;
  /** The commit the PR's branch pointed at on GitHub. */
  headOid: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  checks: Checks;
  /** Names of the checks that failed, for the Fix CI prompt. */
  failing: string[];
  conflicts: boolean;
  review: "approved" | "changes" | "required" | null;
}

export type PrState =
  | { kind: "found"; pr: PullRequest; at: number }
  | { kind: "none"; at: number }
  | { kind: "unavailable"; reason: string; at: number };

type Lookup =
  | { kind: "found"; pr: Record<string, unknown> }
  | { kind: "none" }
  | { kind: "unavailable"; reason: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One check's word: a check run's conclusion once completed, its status
 *  until then; a commit status carries a `state` instead. */
function checkWord(c: Record<string, unknown>): string {
  if ("state" in c) return str(c.state);
  return str(c.status) === "COMPLETED" ? str(c.conclusion) : str(c.status);
}

const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export function foldPr(v: Record<string, unknown>): PullRequest {
  const rollup = Array.isArray(v.statusCheckRollup) ? (v.statusCheckRollup as Record<string, unknown>[]) : [];
  let checks: Checks = "none";
  const failing: string[] = [];
  for (const c of rollup) {
    const word = checkWord(c);
    if (FAILED.has(word)) failing.push(str(c.name) || str(c.context) || "a check");
    else if (!PASSED.has(word)) checks = "pending";
    else if (checks === "none") checks = "passing";
  }
  if (failing.length) checks = "failing";
  const state = str(v.state);
  const decision = str(v.reviewDecision);
  return {
    number: Number(v.number) || 0,
    headOid: str(v.headRefOid),
    url: str(v.url),
    title: str(v.title),
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : v.isDraft ? "draft" : "open",
    checks,
    failing,
    conflicts: str(v.mergeable) === "CONFLICTING",
    review:
      decision === "APPROVED" ? "approved" : decision === "CHANGES_REQUESTED" ? "changes" : decision === "REVIEW_REQUIRED" ? "required" : null,
  };
}

async function lookup(wt: Worktree): Promise<PrState> {
  const at = Date.now();
  try {
    const r: Lookup = isPreview()
      ? (await import("./mock")).mockPr(wt.id)
      : await invoke<Lookup>("gh_pr", { path: wt.path });
    if (r.kind === "found") return { kind: "found", pr: foldPr(r.pr), at };
    if (r.kind === "none") return { kind: "none", at };
    return { kind: "unavailable", reason: r.reason, at };
  } catch (e) {
    return { kind: "unavailable", reason: String(e), at };
  }
}

const inFlight = new Set<string>();
/** gh processes at once: each is a network round trip, and a project with
 *  a dozen worktrees shouldn't fork a dozen. */
const MAX_PARALLEL = 3;
/** How often to re-ask about a PR that's done (merged or closed) or a
 *  checkout gh can't answer for (no GitHub remote, signed out). */
const SETTLED_MS = 30 * 60_000;

function settled(p: PrState | undefined): boolean {
  return p?.kind === "unavailable" || (p?.kind === "found" && (p.pr.state === "merged" || p.pr.state === "closed"));
}

/** Look up these worktrees' PRs; ones asked about within `minAge` are
 *  skipped, and settled ones within half an hour unless `minAge` is 0 (an
 *  explicit refresh). */
export async function refreshPrs(ids: string[], minAge = 0) {
  const s = getState();
  const now = Date.now();
  const todo = ids.filter((id) => {
    const wt = s.worktrees[id];
    // The main checkout's branch is the base PRs merge into, not one.
    if (!wt || wt.is_main || inFlight.has(id)) return false;
    const prev = s.prs[id];
    const age = minAge > 0 && settled(prev) ? Math.max(minAge, SETTLED_MS) : minAge;
    return !prev || now - prev.at >= age;
  });
  if (!todo.length) return;
  todo.forEach((id) => inFlight.add(id));
  const queue = [...todo];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const wt = getState().worktrees[id];
      const result = wt ? await lookup(wt) : null;
      inFlight.delete(id);
      if (result) setState((st) => ({ prs: { ...st.prs, [id!]: result } }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, todo.length) }, worker));
}

const FAST_MS = 60_000;
const SLOW_MS = 5 * 60_000;

/** Mount once: keeps `state.prs` current — the selected project's branches
 *  every minute while the window is in front, the rest every five, and a
 *  branch soon after its git state moves (a push lands, a merge deletes it). */
export function usePrPolling() {
  useEffect(() => {
    const selected = () => {
      const s = getState();
      return s.selectedProject ? projectWorktrees(s, s.selectedProject).map((w) => w.id) : [];
    };
    const tick = setInterval(() => {
      if (document.hidden) return;
      if (document.hasFocus()) void refreshPrs(selected(), FAST_MS - 5_000);
      void refreshPrs(Object.keys(getState().worktrees), SLOW_MS);
    }, 15_000);
    const offStatus = onAgentStatus((a) => {
      if (a.status === "finished") void refreshPrs([a.worktree_id], 10_000);
    });
    // A push or a merge shows in git first: ahead drops, or the upstream goes.
    let git = getState().git;
    let project: string | null = null;
    const offStore = subscribe(() => {
      const s = getState();
      if (s.git !== git) {
        const moved = Object.keys(s.git).filter((id) => {
          const a = git[id];
          const b = s.git[id];
          if (!a || !b || "error" in a || "error" in b) return false;
          return a.ahead !== b.ahead || a.upstream !== b.upstream || a.upstreamGone !== b.upstreamGone;
        });
        git = s.git;
        if (moved.length) void refreshPrs(moved, 5_000);
      }
      if (s.selectedProject !== project) {
        project = s.selectedProject;
        void refreshPrs(selected(), FAST_MS);
      }
    });
    return () => {
      clearInterval(tick);
      offStatus();
      offStore();
    };
  }, []);
}

export async function createPr(wt: Worktree, draft = false): Promise<string> {
  const url = isPreview()
    ? `https://github.com/acme/${wt.branch}/pull/42`
    : await invoke<string>("gh_pr_create", { path: wt.path, draft });
  void refreshPrs([wt.id]);
  return url;
}

/** The prompt that hands a red CI run to an agent. */
export function fixCiPrompt(pr: PullRequest, branch: string): string {
  const which = pr.failing.length ? ` (${pr.failing.slice(0, 8).join(", ")})` : "";
  return `CI is failing on pull request #${pr.number} for ${branch}${which}. Use \`gh pr checks ${pr.number}\` and \`gh run view --log-failed\` to find out why, fix the cause (not the test, unless the test is wrong), run the relevant checks locally, then commit and push. Finish with what was wrong and what you changed.`;
}
