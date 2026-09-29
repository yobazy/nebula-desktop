import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { byId, getState, setState } from "./store";
import { onStatusChanged, updateBadge } from "./notify";
import type {
  Agent,
  AgentPreset,
  EntityId,
  LinkState,
  PtyChunk,
  ServerEvent,
  SessionRef,
} from "./types";
import { sessionKey } from "./types";

// ---- requests ----

let nextReqId = 1;
const pending = new Map<
  number,
  { resolve: (created: EntityId | null) => void; reject: (e: Error) => void }
>();

/** Set in the browser preview, where there is no Tauri backend. */
let mockSend:
  | ((variant: string, body?: Record<string, unknown>) => EntityId | { error: string } | null | void)
  | null = null;

const PREVIEW = !("__TAURI_INTERNALS__" in window);

/** The browser preview (`npm run dev` outside Tauri), with demo data. */
export function isPreview(): boolean {
  return PREVIEW;
}

const statusListeners = new Set<(agent: Agent, from: Agent["status"]) => void>();

/** Called on every agent status change, after the store has it. */
export function onAgentStatus(fn: (agent: Agent, from: Agent["status"]) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** Announce a status change the app made itself (limits.ts), as one from
 *  the daemon is. */
export function statusChanged(agent: Agent, from: Agent["status"]) {
  onStatusChanged(agent, from);
  statusListeners.forEach((fn) => fn(agent, from));
}

/** Fire-and-forget request, e.g. `send("Detach", { session })`. */
export function send(variant: string, body?: Record<string, unknown>): Promise<void> {
  if (mockSend) {
    const created = mockSend(variant, body) ?? null;
    if (body && "req_id" in body) {
      const id = body.req_id as number;
      setTimeout(() => {
        tails.get(id)?.(created as unknown as Tail);
        tails.delete(id);
        // The preview's daemon refuses a request by answering { error }.
        if (created && "error" in created) pending.get(id)?.reject(new Error(String(created.error)));
        else pending.get(id)?.resolve(created);
        pending.delete(id);
      });
    }
    return Promise.resolve();
  }
  const request = body === undefined ? variant : { [variant]: body };
  // Attach, Detach and Resize must reach the daemon in the order they were
  // made — a Detach from one pane overtaking the next pane's Attach of the
  // same session would leave it blank — and separate invokes don't promise
  // that. So they queue behind one another; everything else goes at once.
  if (ORDERED.has(variant)) {
    const next = ordered.then(() => invoke<void>("send", { request }));
    ordered = next.catch(() => {});
    return next;
  }
  return invoke("send", { request });
}

const ORDERED = new Set(["Attach", "Detach", "Resize"]);
let ordered: Promise<void> = Promise.resolve();

/** An RPC-style request: resolves with the Ack's created id, rejects with the
 *  daemon's Error message. */
export function request(
  variant: string,
  body: Record<string, unknown>,
): Promise<EntityId | null> {
  const req_id = nextReqId++;
  return new Promise((resolve, reject) => {
    pending.set(req_id, { resolve, reject });
    send(variant, { ...body, req_id }).catch((e) => {
      pending.delete(req_id);
      reject(new Error(String(e)));
    });
  });
}

export type Tail = { end_seq: number; data: Uint8Array } | null;
const tails = new Map<number, (tail: Tail) => void>();

/** The end of a live session's output, without attaching to it: at most
 *  `maxBytes`, and nothing when the ring hasn't grown past `afterSeq`.
 *  Resolves null for a session with no live PTY, or no answer in 5s. */
export function tailOutput(session: SessionRef, maxBytes: number, afterSeq: number | null): Promise<Tail> {
  const req_id = nextReqId++;
  return new Promise((resolve) => {
    tails.set(req_id, resolve);
    const drop = () => {
      if (tails.delete(req_id)) resolve(null);
    };
    send("TailOutput", { req_id, session, max_bytes: maxBytes, after_seq: afterSeq }).catch(drop);
    setTimeout(drop, 5_000);
  });
}

export function sendInput(session: SessionRef, data: string): Promise<void> {
  if (mockSend) return Promise.resolve();
  return invoke("send_input", { session, data });
}

export function readSettings(): Promise<Record<string, unknown>> {
  if (mockSend) return Promise.resolve({ codex_enabled: true, cursor_enabled: true });
  return invoke("read_settings");
}

export function readPresets(): Promise<AgentPreset[]> {
  if (mockSend) return Promise.resolve([]);
  return invoke("read_presets");
}

export interface FolderInfo {
  exists: boolean;
  /** Symlinks resolved when the folder exists. */
  path: string;
  inGitRepo: boolean;
}

export function inspectFolder(path: string): Promise<FolderInfo> {
  if (mockSend) return Promise.resolve({ exists: true, path, inGitRepo: false });
  return invoke("inspect_folder", { path });
}

/** The native folder picker; null when cancelled. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (mockSend) return "/Users/dev/code/new-idea";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, defaultPath, title: "Open a folder as a project" });
  return typeof picked === "string" ? picked : null;
}

/** Dev builds mirror key events to the app's stdout (`[webview] …`). */
export function debugLog(msg: string) {
  if (import.meta.env.DEV && !mockSend) void invoke("debug_log", { msg }).catch(() => {});
}

export function startDaemon(): Promise<void> {
  if (isPreview()) return Promise.resolve();
  return invoke("start_daemon");
}

export interface NebulaStatus {
  /** The nebula version this app is built for. */
  pinned: string;
  path: string | null;
  version: string | null;
}

/** The preview's stand-in for the startup screen's states: `?gate=missing`,
 *  `older`, `newer` or `stopped` in the URL. */
export const PREVIEW_GATE = PREVIEW ? new URLSearchParams(location.search).get("gate") : null;

export function nebulaStatus(): Promise<NebulaStatus> {
  if (isPreview()) {
    const fakes: Record<string, string | null> = { missing: null, older: "0.39.0", newer: "0.41.0" };
    const version = PREVIEW_GATE && PREVIEW_GATE in fakes ? fakes[PREVIEW_GATE] : "0.40.2";
    return Promise.resolve({ pinned: "0.40.2", path: version ? "~/.local/bin/nebula" : null, version });
  }
  return invoke("nebula_status");
}

/** Install the nebula release this app is built for (nebula_setup.rs). */
export function installNebula(): Promise<NebulaStatus> {
  if (isPreview()) {
    return new Promise((r) => setTimeout(() => r({ pinned: "0.40.2", path: "~/.local/bin/nebula", version: "0.40.2" }), 1200));
  }
  return invoke("install_nebula");
}

// ---- PTY routing ----

type PtyHandler = (chunk: PtyChunk, bytes: Uint8Array) => void;
const ptyHandlers = new Map<string, PtyHandler>();
const exitHandlers = new Map<string, (code: number | null) => void>();

export function onPty(session: SessionRef, handler: PtyHandler): () => void {
  const key = sessionKey(session);
  ptyHandlers.set(key, handler);
  return () => {
    if (ptyHandlers.get(key) === handler) ptyHandlers.delete(key);
  };
}

export function onExit(session: SessionRef, handler: (code: number | null) => void) {
  const key = sessionKey(session);
  exitHandlers.set(key, handler);
  return () => {
    if (exitHandlers.get(key) === handler) exitHandlers.delete(key);
  };
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- event handling ----

/** An agent row from the daemon, kept waiting on you while limits.ts holds
 *  it at a usage limit: until the daemon has status news of its own. */
function held(a: Agent): Agent {
  const hit = getState().limits[a.id];
  if (!hit) return a;
  if (a.status === "running" && a.status_changed_at === hit.since) return { ...a, status: "needs_feedback" };
  setState((s) => {
    const limits = { ...s.limits };
    delete limits[a.id];
    return { limits };
  });
  return a;
}

function handle(event: ServerEvent) {
  if ("Snapshot" in event) {
    const s = event.Snapshot;
    const agents = s.agents.map(held);
    setState((prev) => ({
      loaded: true,
      snapshots: prev.snapshots + 1,
      projects: byId(s.projects),
      worktrees: byId(s.worktrees),
      agents: byId(agents),
      terminals: byId(s.terminals),
      selectedProject:
        prev.selectedProject && s.projects.some((p) => p.id === prev.selectedProject)
          ? prev.selectedProject
          : (s.projects[0]?.id ?? null),
    }));
    updateBadge();
    debugLog(
      `snapshot: ${s.projects.length} projects, ${s.worktrees.length} worktrees, ${s.agents.length} agents`,
    );
  } else if ("Ack" in event) {
    const { req_id, created } = event.Ack;
    pending.get(req_id)?.resolve(created);
    pending.delete(req_id);
  } else if ("Error" in event) {
    const { req_id, message } = event.Error;
    if (req_id != null && pending.has(req_id)) {
      pending.get(req_id)!.reject(new Error(message));
      pending.delete(req_id);
    } else {
      console.warn("[nebula]", message);
    }
  } else if ("EntityUpserted" in event) {
    const e = event.EntityUpserted.entity;
    if ("Project" in e) setState((s) => ({ projects: { ...s.projects, [e.Project.id]: e.Project } }));
    else if ("Worktree" in e)
      setState((s) => ({ worktrees: { ...s.worktrees, [e.Worktree.id]: e.Worktree } }));
    else if ("Agent" in e) {
      const prev = getState().agents[e.Agent.id];
      const next = held(e.Agent);
      setState((s) => ({ agents: { ...s.agents, [next.id]: next } }));
      if (prev && prev.status !== next.status) statusChanged(next, prev.status);
    } else if ("Terminal" in e)
      setState((s) => ({ terminals: { ...s.terminals, [e.Terminal.id]: e.Terminal } }));
  } else if ("EntityRemoved" in event) {
    const id = event.EntityRemoved.id;
    const drop = <T,>(rows: Record<string, T>, key: string) => {
      const next = { ...rows };
      delete next[key];
      return next;
    };
    if ("Project" in id) setState((s) => ({ projects: drop(s.projects, id.Project) }));
    else if ("Worktree" in id) setState((s) => ({ worktrees: drop(s.worktrees, id.Worktree) }));
    else if ("Agent" in id) setState((s) => ({ agents: drop(s.agents, id.Agent) }));
    else if ("Terminal" in id) setState((s) => ({ terminals: drop(s.terminals, id.Terminal) }));
  } else if ("StatusChanged" in event) {
    const { agent: id, status, changed_at, unseen } = event.StatusChanged;
    const prev = getState().agents[id];
    if (!prev) return;
    const next = held({ ...prev, status, status_changed_at: changed_at, unseen });
    setState((s) => ({ agents: { ...s.agents, [id]: next } }));
    if (prev.status !== next.status) statusChanged(next, prev.status);
    debugLog(`status: ${next.name} ${prev.status} -> ${status}`);
  } else if ("OutputTail" in event) {
    const { req_id, tail } = event.OutputTail;
    tails.get(req_id)?.(tail && { end_seq: tail.end_seq, data: decode(tail.data) });
    tails.delete(req_id);
  } else if ("SessionExited" in event) {
    const { session, exit_code } = event.SessionExited;
    exitHandlers.get(sessionKey(session))?.(exit_code);
  }
}

// ---- lifecycle ----

let started = false;
let retry: ReturnType<typeof setTimeout> | null = null;

async function tryConnect() {
  retry = null;
  try {
    await invoke<number>("connect");
    setState((s) => ({ epoch: s.epoch + 1 }));
  } catch (e) {
    const reason = String(e);
    if (reason === "already connected") return;
    setState({ link: { state: "disconnected", reason } });
    scheduleRetry();
  }
}

function scheduleRetry() {
  if (!retry) retry = setTimeout(tryConnect, 3000);
}

/** Wire the event listeners once and connect, reconnecting on loss. */
export async function start() {
  if (started) return;
  started = true;
  if (PREVIEW) {
    const { startMock } = await import("./mock");
    mockSend = startMock(ptyHandlers);
    // Show the startup screen in one of its states instead of the demo.
    if (PREVIEW_GATE) setState({ loaded: false, link: { state: "disconnected", reason: "No nebula daemon is listening." } });
    return;
  }
  await listen<ServerEvent>("nebula://event", (e) => handle(e.payload));
  await listen<PtyChunk>("nebula://pty", (e) => {
    const handler = ptyHandlers.get(sessionKey(e.payload.session));
    handler?.(e.payload, decode(e.payload.data));
  });
  await listen<LinkState>("nebula://link", (e) => {
    setState({ link: e.payload });
    if (e.payload.state === "disconnected") {
      for (const p of pending.values()) p.reject(new Error(e.payload.reason));
      pending.clear();
      scheduleRetry();
    }
  });
  await tryConnect();
}

export function reconnectNow() {
  if (retry) clearTimeout(retry);
  void tryConnect();
}
