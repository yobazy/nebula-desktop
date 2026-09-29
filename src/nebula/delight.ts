// The small pleasures: a soft sound when a turn ends or an agent needs
// you, the sidebar cat reacting to what happens (a push landing, a merge,
// red CI), and quiet hours that hush both, and the banners, at night.
import { useEffect } from "react";
import { onAgentStatus } from "./client";
import { getState, subscribe } from "./store";
import { isQuietNow } from "./quiet";
import type { Agent } from "./types";

// ---- sounds ----

export type Cue = "done" | "waiting" | "shipped";

let ctx: AudioContext | null = null;

/** Short chimes made on the spot (no audio files): two rising notes for a
 *  finished turn, one bright ping for a question, a little arpeggio for a
 *  merge. Quiet by design; the TUI has its own macOS sounds. */
const TUNES: Record<Cue, [freq: number, at: number, len: number][]> = {
  done: [
    [659.25, 0, 0.18],
    [987.77, 0.11, 0.28],
  ],
  waiting: [
    [880, 0, 0.12],
    [880, 0.16, 0.22],
  ],
  shipped: [
    [523.25, 0, 0.16],
    [659.25, 0.09, 0.16],
    [783.99, 0.18, 0.16],
    [1046.5, 0.27, 0.36],
  ],
};

/** Make the audio context on the first click or key, so it starts
 *  running: WebKit keeps one made from a background event suspended. */
function unlockAudio() {
  const go = () => {
    try {
      ctx ??= new AudioContext();
      if (ctx.state !== "running") void ctx.resume();
    } catch {
      // No audio: chimes stay silent.
    }
  };
  window.addEventListener("pointerdown", go, { once: true, capture: true });
  window.addEventListener("keydown", go, { once: true, capture: true });
}

export function play(cue: Cue, force = false) {
  const { prefs } = getState();
  if (!force && (prefs.sounds === false || isQuietNow())) return;
  try {
    ctx ??= new AudioContext();
    const c = ctx;
    // WebKit starts a context made outside a gesture suspended.
    if (c.state !== "running") void c.resume();
    const volume = Math.max(0, Math.min(1, prefs.soundVolume ?? 0.5)) * 0.18;
    const start = c.currentTime + 0.01;
    for (const [freq, at, len] of TUNES[cue]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start + at);
      gain.gain.linearRampToValueAtTime(volume, start + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + len);
      osc.connect(gain).connect(c.destination);
      osc.start(start + at);
      osc.stop(start + at + len + 0.05);
    }
  } catch {
    // No audio device, or the webview refused: a missed chime is fine.
  }
}

// ---- the cat ----

export type PetMood = "happy" | "party" | "sad";
const petListeners = new Set<(mood: PetMood) => void>();

export function onPetMood(fn: (mood: PetMood) => void): () => void {
  petListeners.add(fn);
  return () => petListeners.delete(fn);
}

function cheer(mood: PetMood) {
  petListeners.forEach((fn) => fn(mood));
}

// ---- wiring ----

/** Whether you're already looking at this agent: no chime for what's in
 *  front of you. */
function watching(agent: Agent): boolean {
  const sel = getState().selectedSession;
  return document.hasFocus() && !!sel && "Agent" in sel && sel.Agent === agent.id;
}

/** Mount once: sounds and cat reactions for what happens in the store. */
export function useDelight() {
  useEffect(() => {
    const offStatus = onAgentStatus((agent, from) => {
      if (agent.archived) return;
      if (agent.status === "needs_feedback") {
        if (!watching(agent)) play("waiting");
      } else if (agent.status === "finished" && from === "running") {
        if (!watching(agent)) play("done");
        cheer("happy");
      }
    });

    // Pushes, merges and red CI show up in git and PR state, compared with
    // what they were a moment ago — never on the first read after a
    // (re)connect, or every launch would celebrate old news.
    unlockAudio();
    let git = getState().git;
    let prs = getState().prs;
    // Each PR's last checks verdict that wasn't "pending": a fix goes
    // failing → pending → passing, and the cheer is for the round trip.
    const verdict = new Map<string, { number: number; checks: string }>();
    const offStore = subscribe(() => {
      const s = getState();
      if (s.git !== git) {
        for (const [id, now] of Object.entries(s.git)) {
          const was = git[id];
          if (!was || "error" in was || "error" in now) continue;
          // Commits that were waiting to go up went up.
          if (was.ahead > 0 && now.ahead === 0 && !!now.upstream && !now.upstreamGone && was.upstream === now.upstream) cheer("happy");
          // A branch pushed for the first time.
          else if (!was.upstream && now.upstream && now.ahead === 0) cheer("happy");
        }
        git = s.git;
      }
      if (s.prs !== prs) {
        for (const [id, now] of Object.entries(s.prs)) {
          const was = prs[id];
          if (now.kind !== "found") continue;
          const last = verdict.get(id);
          const settled = now.pr.checks === "passing" || now.pr.checks === "failing";
          if (settled) verdict.set(id, { number: now.pr.number, checks: now.pr.checks });
          if (was?.kind !== "found" || was.pr.number !== now.pr.number) continue;
          if (was.pr.state !== "merged" && now.pr.state === "merged") {
            cheer("party");
            play("shipped");
          } else if (settled && last?.number === now.pr.number && last.checks !== now.pr.checks) {
            cheer(now.pr.checks === "failing" ? "sad" : "happy");
          }
        }
        prs = s.prs;
      }
    });
    return () => {
      offStatus();
      offStore();
    };
  }, []);
}
