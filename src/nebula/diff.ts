// A checkout's changes for the review view: `git diff` from git.rs, parsed
// into files, hunks and numbered lines here, where the view needs them.
import { invoke } from "@tauri-apps/api/core";
import { isPreview } from "./client";
import { getState, setState } from "./store";
import type { Worktree } from "./types";

export type LineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** Line numbers on each side; null on the side the line isn't on. */
  old: number | null;
  new: number | null;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "untracked";

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  /** Untracked and over the size cap: not read. */
  tooBig: boolean;
  insertions: number;
  deletions: number;
  hunks: Hunk[];
}

export interface Diff {
  files: DiffFile[];
  truncated: boolean;
  against: string;
}

interface RawDiff {
  patch: string;
  untracked: { path: string; text: string | null; size: number; tooBig?: boolean }[];
  truncated: boolean;
  against: string;
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };

/** A path as git writes it: bare, or C-quoted with octal escapes for bytes
 *  (quotePath is off, but quotes, backslashes and control characters are
 *  still escaped). The trailing tab git adds after a name with spaces goes. */
export function unquote(p: string): string {
  p = p.replace(/\t$/, "");
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...enc.encode(body[i]));
      continue;
    }
    const n = body[++i] ?? "";
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(oct, 8));
      i += oct.length - 1;
    } else bytes.push(ESCAPES[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const stripPrefix = (p: string) => unquote(p).replace(/^[ab]\//, "");

/** The path in a `diff --git a/X b/X` header whose X has spaces (so the
 *  two halves can't be split on whitespace): the halves are the same when
 *  nothing was renamed, which is the only case that needs this. */
function headerPath(rest: string): string {
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) return stripPrefix(quoted[2]);
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(2, half);
  return stripPrefix(rest.split(" ").pop() ?? rest);
}

/** Parse `git diff` output. Lenient: an unexpected line ends a hunk rather
 *  than failing the whole diff. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = headerPath(line.slice(11));
      file = { path, oldPath: null, status: "modified", binary: false, tooBig: false, insertions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = unquote(line.slice(12));
      } else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10));
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("--- ") && !line.startsWith("--- /dev/null")) file.path = stripPrefix(line.slice(4));
      else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) file.path = stripPrefix(line.slice(4));
    }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1), old: null, new: newNo++ });
      file.insertions++;
    } else if (c === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1), old: oldNo++, new: null });
      file.deletions++;
    } else if (c === " ") {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), old: oldNo++, new: newNo++ });
    } else if (c !== "\\") {
      // "\ No newline at end of file" is noise; anything else ends the hunk.
      hunk = null;
    }
  }
  return files;
}

function untrackedFile(u: RawDiff["untracked"][number]): DiffFile {
  const text = u.text ?? "";
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text ? text.split("\n") : [];
  return {
    path: u.path,
    oldPath: null,
    status: "untracked",
    binary: u.text === null && !u.tooBig,
    tooBig: !!u.tooBig,
    insertions: lines.length,
    deletions: 0,
    hunks: lines.length
      ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((t, i) => ({ kind: "add", text: t, old: null, new: i + 1 })) }]
      : [],
  };
}

/** Show the review view for a checkout. */
export function openReview(worktreeId: string) {
  setState({ view: "review", review: worktreeId });
}

/** The main checkout's branch: what "the whole branch" is measured from. */
export function baseBranch(wt: Worktree): string | null {
  const main = Object.values(getState().worktrees).find((w) => w.project_id === wt.project_id && w.is_main);
  return main && main.id !== wt.id ? main.branch : null;
}

export async function loadDiff(wt: Worktree, scope: "uncommitted" | "branch"): Promise<Diff> {
  const base = scope === "branch" ? baseBranch(wt) : null;
  const raw: RawDiff = isPreview()
    ? (await import("./mock")).mockDiff(wt.id, scope)
    : await invoke<RawDiff>("git_diff", { path: wt.path, base });
  const files = [...parsePatch(raw.patch), ...raw.untracked.map(untrackedFile)];
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated: raw.truncated, against: raw.against };
}

// ---- review comments ----

export interface ReviewComment {
  id: string;
  path: string;
  /** The line it's on (new side, else old), or null for the file as a whole. */
  line: number | null;
  side: "new" | "old";
  /** The line's text, so the agent can find it if the numbers moved. */
  quote: string;
  text: string;
}

/** Comments kept per worktree while the app runs, so closing the review to
 *  look at something doesn't lose a half-written review. */
const drafts = new Map<string, ReviewComment[]>();

export function draftsFor(worktreeId: string): ReviewComment[] {
  return drafts.get(worktreeId) ?? [];
}

export function saveDrafts(worktreeId: string, comments: ReviewComment[]) {
  if (comments.length) drafts.set(worktreeId, comments);
  else drafts.delete(worktreeId);
}

/** Put comments back on their lines in a fresh diff: where their quoted
 *  text still is at the same number, else the nearest line with that text
 *  on the same side. Ones whose line is gone come back in `unplaced`, still
 *  part of the review (their quote says where they were). */
export function anchorComments(comments: ReviewComment[], files: DiffFile[]): { comments: ReviewComment[]; unplaced: Set<string> } {
  const unplaced = new Set<string>();
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out = comments.map((c) => {
    const file = byPath.get(c.path);
    if (!file) {
      unplaced.add(c.id);
      return c;
    }
    if (c.line === null) return c;
    const lines = file.hunks.flatMap((h) => h.lines).filter((l) => (c.side === "new" ? l.new !== null : l.old !== null));
    const at = (l: DiffLine) => (c.side === "new" ? l.new! : l.old!);
    if (lines.some((l) => at(l) === c.line && l.text === c.quote)) return c;
    const same = lines.filter((l) => l.text === c.quote);
    if (!same.length) {
      unplaced.add(c.id);
      return c;
    }
    const best = same.reduce((a, b) => (Math.abs(at(b) - c.line!) < Math.abs(at(a) - c.line!) ? b : a));
    return { ...c, line: at(best) };
  });
  return { comments: out, unplaced };
}

/** The review, in the words the agent gets. */
export function reviewPrompt(comments: ReviewComment[], summary: string): string {
  const parts = ["I reviewed the changes in this worktree. Address each comment below, then give me a short summary of what you changed."];
  if (summary.trim()) parts.push(summary.trim());
  for (const c of comments) {
    const where = c.line === null ? c.path : `${c.path}:${c.line}${c.side === "old" ? " (removed line)" : ""}`;
    const quote = c.quote.trim() ? `\n  > ${c.quote.trim().slice(0, 200)}` : "";
    parts.push(`${where}${quote}\n  ${c.text.trim().replace(/\n/g, "\n  ")}`);
  }
  return parts.join("\n\n");
}
