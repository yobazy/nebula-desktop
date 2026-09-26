// Mirrors of nebula-core's serde shapes (externally tagged enums, snake_case
// status/kind strings). Pinned to nebula v0.40.2, protocol 44.

export type AgentStatus =
  | "fresh"
  | "running"
  | "finished"
  | "needs_feedback"
  | "terminated"
  | "disconnected";

export type AgentKind =
  | "claude"
  | "codex"
  | "cursor"
  | "pi"
  | "muse"
  | "grok"
  | "open_code"
  | "custom";

export interface Project {
  id: string;
  name: string;
  repo_path: string;
  sort_order: number;
}

export interface Worktree {
  id: string;
  project_id: string;
  path: string;
  branch: string;
  is_main: boolean;
  sort_order: number;
}

export interface PromptEntry {
  text: string;
  submitted_at: number;
}

export interface Agent {
  id: string;
  worktree_id: string;
  name: string;
  status: AgentStatus;
  archived: boolean;
  archived_at: number;
  unseen: boolean;
  status_changed_at: number;
  kind: AgentKind;
  custom_harness: string | null;
  model: string | null;
  effort: string | null;
  session_id: string | null;
  cloud_session_id: string | null;
  issue_url: string | null;
  sort_order: number;
  alive: boolean;
  recent_prompts: PromptEntry[];
}

export interface TerminalTab {
  id: string;
  worktree_id: string;
  name: string;
  sort_order: number;
  alive: boolean;
  run_command: string | null;
}

export type SessionRef = { Agent: string } | { Terminal: string };

export type Entity =
  | { Project: Project }
  | { Worktree: Worktree }
  | { Agent: Agent }
  | { Terminal: TerminalTab }
  | { Link: unknown };

export type EntityId =
  | { Project: string }
  | { Worktree: string }
  | { Agent: string }
  | { Terminal: string }
  | { Link: string };

export type ServerEvent =
  | {
      Snapshot: {
        projects: Project[];
        worktrees: Worktree[];
        agents: Agent[];
        terminals: TerminalTab[];
      };
    }
  | { Ack: { req_id: number; created: EntityId | null } }
  | { Error: { req_id: number | null; message: string } }
  | { EntityUpserted: { entity: Entity } }
  | { EntityRemoved: { id: EntityId } }
  | {
      StatusChanged: {
        agent: string;
        status: AgentStatus;
        changed_at: number;
        unseen: boolean;
      };
    }
  | { SessionExited: { session: SessionRef; exit_code: number | null } }
  | {
      OutputTail: {
        req_id: number;
        session: SessionRef;
        /** Null when the session has no live PTY. `data` is base64 (daemon.rs). */
        tail: { end_seq: number; data: string } | null;
      };
    };
// Other events (HelloOk, KittyFlags, FilesOpened, Metrics, …) arrive too and
// fall through the handler unmatched.

export interface PtyChunk {
  session: SessionRef;
  replay: boolean;
  seq: number;
  data: string;
}

export type LinkState =
  | { state: "connecting" }
  | { state: "connected"; daemonPid: number }
  | { state: "disconnected"; reason: string };

export interface AgentPreset {
  name: string;
  kind: AgentKind;
  custom_harness?: string | null;
  model?: string | null;
  effort?: string | null;
  prefix?: string;
  postfix?: string;
  skip_task?: boolean;
}

export function sessionKey(ref: SessionRef): string {
  return "Agent" in ref ? `a:${ref.Agent}` : `t:${ref.Terminal}`;
}

export function sameSession(a: SessionRef | null, b: SessionRef | null): boolean {
  return !!a && !!b && sessionKey(a) === sessionKey(b);
}
