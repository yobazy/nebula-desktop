// What an agent's terminal shows right now, without attaching to it: the
// end of its output (TailOutput) played into an off-screen xterm, so cursor
// moves and redraws land where they would on screen, then read back as
// plain lines. From those, a question with numbered choices — a permission
// prompt — can be answered from outside the terminal.
import { Terminal } from "@xterm/xterm";
import { sendInput, tailOutput } from "./client";
import type { Agent } from "./types";

/** The grid each agent's PTY was last sized to by this app, and the main
 *  terminal's for ones it never sized: the CLI draws (and redraws, by
 *  relative cursor moves) for that width, so replaying at another one
 *  garbles the screen. */
const sizes = new Map<string, { cols: number; rows: number }>();
let lastSize = { cols: 100, rows: 40 };

export function noteSize(agentId: string, cols: number, rows: number) {
  sizes.set(agentId, { cols, rows });
  lastSize = { cols, rows };
}

/** The last rows of the agent's screen, trimmed; null when it has no live
 *  terminal to read. */
export async function readScreen(agent: Agent, maxBytes = 48_000): Promise<string[] | null> {
  if (!agent.alive) return null;
  const tail = await tailOutput({ Agent: agent.id }, maxBytes, null);
  if (!tail) return null;
  const { cols, rows } = sizes.get(agent.id) ?? lastSize;
  const term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  try {
    await new Promise<void>((r) => term.write(tail.data, r));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.slice(-rows);
  } finally {
    term.dispose();
  }
}

export interface Choice {
  /** What to type to pick it. */
  key: string;
  label: string;
  selected: boolean;
}

export interface Question {
  /** The question's own line(s), above the choices. */
  prompt: string;
  choices: Choice[];
}

/** Box-drawing edges and the marks a picker puts before its current row. */
const EDGE = /^[\s│┃|╭╰╮╯─]+|[\s│┃|╭╰╮╯─]+$/g;
const CHOICE = /^([❯›>▶●]\s*)?(\d{1,2})[.)]\s+(.+)$/;

/** The numbered choices at the bottom of a screen, as Claude Code, Codex and
 *  friends draw a permission prompt: "❯ 1. Yes", "2. No, and tell me…". Only
 *  a run numbered 1, 2, 3… in the last rows counts, so a numbered list in
 *  the agent's prose above doesn't. */
export function findQuestion(lines: string[]): Question | null {
  const rows = lines.map((l) => l.replace(EDGE, ""));
  let end = rows.length - 1;
  // Footer hints ("Esc to cancel · Tab to amend") may sit under the choices.
  let skipped = 0;
  while (end >= 0 && !CHOICE.test(rows[end]) && skipped < 6) {
    end--;
    skipped++;
  }
  if (end < 0 || !CHOICE.test(rows[end])) return null;
  const choices: Choice[] = [];
  // Rows a label wrapped onto, waiting for the choice above them.
  let wrapped: string[] = [];
  let i = end;
  for (; i >= 0; i--) {
    const m = rows[i].match(CHOICE);
    if (!m) {
      // A choice's label may wrap onto a row or two of its own: keep going
      // if the choice before this one sits just above.
      const want = String(Number(choices[0].key) - 1);
      const wraps = rows[i].trim() && [1, 2].some((k) => rows[i - k]?.match(CHOICE)?.[2] === want);
      if (wraps) {
        wrapped.unshift(rows[i].trim());
        continue;
      }
      break;
    }
    choices.unshift({ key: m[2], label: [m[3].trim(), ...wrapped].join(" "), selected: !!m[1] });
    wrapped = [];
  }
  // The last choice's label may wrap too, onto rows the footer skip above
  // passed over: rows indented exactly to where its label starts.
  const lastRaw = lines[end].replace(/^[│┃|]/, "");
  const labelAt = lastRaw.search(/\S/) >= 0 ? lastRaw.indexOf(choices[choices.length - 1]?.label.split(" ")[0] ?? "\u0000") : -1;
  if (labelAt > 0) {
    for (let j = end + 1; j < lines.length; j++) {
      const raw = lines[j].replace(/^[│┃|]/, "");
      if (!raw.trim() || raw.search(/\S/) !== labelAt) break;
      choices[choices.length - 1].label += ` ${raw.trim().replace(EDGE, "")}`;
    }
  }
  if (!choices.length || choices[0].key !== "1") return null;
  if (!choices.every((c, n) => Number(c.key) === n + 1)) return null;
  // A picker marks exactly one row as current; a numbered list in prose
  // marks none.
  if (choices.filter((c) => c.selected).length !== 1) return null;
  const above: string[] = [];
  for (let j = i; j >= 0 && above.length < 3; j--) {
    const t = rows[j].trim();
    if (!t) {
      if (above.length) break;
      continue;
    }
    above.unshift(t);
  }
  return { prompt: above.join(" "), choices };
}

/** Whether the screen's bottom rows hold a picker this module couldn't
 *  read: typing a reply there would have Enter pick its current row. */
export function looksLikePicker(lines: string[]): boolean {
  // Not a bare ❯ or ›: Claude Code and Codex draw their ordinary input line
  // with one. A marked numbered row, or two numbered rows, is a menu — or
  // a numbered list, where sending you to the terminal is the safe miss.
  const rows = lines.slice(-10).map((l) => l.replace(EDGE, ""));
  return rows.some((l) => /^[❯›▶>]\s*\d{1,2}[.)]\s/.test(l)) || rows.filter((l) => /^\d{1,2}[.)]\s/.test(l)).length >= 2;
}

/** Pick a choice by its number, as pressing the key in the terminal does —
 *  after checking the same question is still on screen, since the agent
 *  may have moved on (or you answered in the terminal) since it was read. */
export async function answer(agent: Agent, q: Question, choice: Choice): Promise<void> {
  const lines = await readScreen(agent);
  const now = lines && findQuestion(lines);
  const same =
    now && now.prompt === q.prompt && now.choices.some((c) => c.key === choice.key && c.label === choice.label);
  if (!same) throw new Error(`${agent.name} isn't asking that any more`);
  await sendInput({ Agent: agent.id }, choice.key);
}

/** The screen's last few meaningful rows, for a preview. */
export function lastRows(lines: string[], n: number): string[] {
  return lines
    .map((l) => l.replace(EDGE, "").trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}
