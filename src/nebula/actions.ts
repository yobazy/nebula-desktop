// Things the app asks agents to do on the user's behalf: start one with a
// task, or hand a prompt to one that's idle on a branch.
import { readSettings, request, sendInput } from "./client";
import { defaultAgentName, settingsStem } from "./status";
import { flash, getState, setState, type State } from "./store";
import { remoteOf, type GitStatus, type ShipKind } from "./git";
import type { Agent, AgentKind, AgentPreset } from "./types";

type Settings = Record<string, unknown>;

export const HARNESSES: AgentKind[] = ["claude", "codex", "cursor", "pi", "muse", "open_code"];

function launchModel(settings: Settings, kind: AgentKind, which: "model" | "effort") {
  const v = settings[`${settingsStem(kind)}_${which}`];
  return typeof v === "string" && v && v !== "default" ? v : null;
}

/** The harness the user starts quick tasks with in the TUI. Settings store
 *  the TUI's own names (`opencode`), not the protocol's (`open_code`). */
export function defaultKind(settings: Settings): AgentKind {
  const k = settings.quick_prompt_kind;
  const kind = HARNESSES.find((h) => settingsStem(h) === k);
  return kind ?? "claude";
}

/** Start an agent in `worktree` and select it. Resolves with its id. */
export async function createAgent(opts: {
  worktree: string;
  kind: AgentKind;
  settings: Settings;
  prompt: string | null;
  preset?: AgentPreset;
}): Promise<string | null> {
  const { worktree, settings, preset } = opts;
  const kind = preset?.kind ?? opts.kind;
  const composed = [preset?.prefix ?? "", opts.prompt ?? "", preset?.postfix ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
  const taken = Object.values(getState().agents)
    .filter((a) => a.worktree_id === worktree)
    .map((a) => a.name);

  const created = await request("CreateAgent", {
    worktree,
    name: defaultAgentName(taken),
    kind,
    custom_harness: preset?.custom_harness ?? null,
    model: preset?.model ?? launchModel(settings, kind, "model"),
    effort: preset?.effort ?? launchModel(settings, kind, "effort"),
    auto_title: true,
    cloud_prompt: null,
    starting_prompt: composed || null,
    issue_url: null,
  });
  if (created && "Agent" in created) {
    setState({ selectedSession: { Agent: created.Agent } });
    return created.Agent;
  }
  return null;
}

/** Type `prompt` into a live agent and submit it, as the TUI's `send_turn`
 *  does: one line as plain keystrokes (a paste would fold into a "[Pasted
 *  text]" placeholder), several as a bracketed paste so line breaks stay
 *  line breaks — then Enter as its own write, once the text has landed. */
export async function deliverPrompt(agent: Agent, prompt: string) {
  const session = { Agent: agent.id };
  await sendInput(session, prompt.includes("\n") ? `\x1b[200~${prompt}\x1b[201~` : prompt);
  await new Promise((r) => setTimeout(r, 150));
  await sendInput(session, "\r");
}

/** A fresh agent this young is most likely still booting with a starting
 *  prompt in hand: its CLI isn't reading yet, so it can't take another. */
const BOOTING_MS = 20_000;

/** Who should take a job on a worktree: an agent that's done and idle there
 *  (the selected one first, else the latest), a new one when there's none,
 *  or nobody while an agent is still mid-turn or waiting on you — its work
 *  isn't finished, and a second agent would commit it half-done. */
export type Taker =
  | { kind: "agent"; agent: Agent }
  | { kind: "new" }
  | { kind: "busy"; agent: Agent };

export function takerFor(s: State, worktreeId: string): Taker {
  const live = Object.values(s.agents).filter(
    (a) => a.worktree_id === worktreeId && !a.archived,
  );
  const now = Date.now();
  const busy = live.find(
    (a) =>
      a.status === "running" ||
      a.status === "needs_feedback" ||
      (a.status === "fresh" && now - a.status_changed_at < BOOTING_MS),
  );
  if (busy) return { kind: "busy", agent: busy };
  const idle = live
    .filter((a) => a.alive && (a.status === "finished" || a.status === "fresh"))
    .sort((a, b) => b.status_changed_at - a.status_changed_at);
  const sel = s.selectedSession;
  const chosen = idle.find((a) => sel && "Agent" in sel && sel.Agent === a.id) ?? idle[0];
  return chosen ? { kind: "agent", agent: chosen } : { kind: "new" };
}

/** Hand `prompt` to whoever should take it on `worktreeId`. Resolves with a
 *  line saying who took it, or rejects with why nobody could. */
export async function runOnWorktree(worktreeId: string, prompt: string, what: string) {
  const s = getState();
  const taker = takerFor(s, worktreeId);
  if (taker.kind === "busy") {
    throw new Error(`${taker.agent.name} is still working on this branch`);
  }
  if (taker.kind === "agent") {
    setState({ selectedSession: { Agent: taker.agent.id } });
    await deliverPrompt(taker.agent, prompt);
    flash(`Asked ${taker.agent.name} to ${what}`);
    return;
  }
  const settings = await readSettings();
  await createAgent({ worktree: worktreeId, kind: defaultKind(settings), settings, prompt });
  flash(`Started an agent to ${what}`);
}

export const SHIP_LABEL: Record<ShipKind, string> = {
  resolve: "Resolve",
  commit: "Commit & push",
  push: "Push",
};

/** What "done" means for each kind, in words for the notice. */
export function shipWhat(kind: ShipKind, branch: string): string {
  return kind === "resolve"
    ? `resolve the conflicts on ${branch}`
    : kind === "commit"
      ? `commit and push ${branch}`
      : `push ${branch}`;
}

/** The job, in the words the agent gets. Built from what git reports is
 *  checked out, not the row's name for it. */
export function shipPrompt(kind: ShipKind, git: GitStatus): string {
  const branch = git.branch ?? "HEAD";
  const remote = remoteOf(git);
  const push = `push ${branch} to ${remote}, setting the upstream if it has none. If the push is rejected because the remote moved, rebase onto it, resolve anything simple, and push again; stop and ask me before force-pushing or resolving real conflicts.`;
  if (kind === "resolve") {
    return `${branch} has merge conflicts from a merge or rebase in progress. Look at what is being merged, resolve the conflicts where the right answer is clear, and finish the merge or rebase. Stop and ask me about any conflict where both sides made real changes. Don't commit conflict markers.`;
  }
  if (kind === "commit") {
    return `Commit the uncommitted changes on ${branch}. Use clear commit messages, and split unrelated changes into separate commits. Don't commit secrets, build output, or anything .gitignore should cover. Then ${push} Finish with the commit hashes and whether the push succeeded.`;
  }
  return `${push[0].toUpperCase()}${push.slice(1)}`;
}
