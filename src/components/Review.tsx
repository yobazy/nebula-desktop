import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOverlayKeys } from "./Overlay";
import { flash, setState, useAppState } from "../nebula/store";
import { changedFiles } from "../nebula/git";
import { takerFor } from "../nebula/actions";
import { handToBranch } from "../nebula/queue";
import {
  anchorComments,
  baseBranch,
  draftsFor,
  loadDiff,
  reviewPrompt,
  saveDrafts,
  type Diff,
  type DiffFile,
  type DiffLine,
  type ReviewComment,
} from "../nebula/diff";
import { ShipButton } from "./Sessions";

type Scope = "uncommitted" | "branch";

/** Files longer than this start folded, so one generated file can't bury
 *  the rest of the review. */
const FOLD_LINES = 1_200;

const STATUS_MARK: Record<DiffFile["status"], string> = {
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  modified: "M",
};

type Target = { path: string; line: number | null; side: "new" | "old"; quote: string };

const targetKey = (t: { path: string; line: number | null; side: string }) => `${t.path}\u0000${t.side}:${t.line ?? "file"}`;

/** A worktree's changes, file by file, with comments you can leave on any
 *  line and hand to the branch's agent in one go. */
export function ReviewView() {
  const state = useAppState();
  const wt = state.review ? state.worktrees[state.review] : undefined;
  const git = wt ? state.git[wt.id] : undefined;
  const dirty = !!git && !("error" in git) && changedFiles(git) > 0;
  const base = wt ? baseBranch(wt) : null;
  const [scope, setScope] = useState<Scope>(dirty || !base ? "uncommitted" : "branch");
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>(() => (wt ? draftsFor(wt.id) : []));
  const [summary, setSummary] = useState("");
  const [composing, setComposing] = useState<Target | null>(null);
  // Comments whose line isn't in the diff as last loaded.
  const [unplaced, setUnplaced] = useState<Set<string>>(() => new Set());
  const [sending, setSending] = useState(false);
  const controls = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useOverlayKeys(controls);

  const wtId = wt?.id;
  useEffect(() => {
    if (wtId) saveDrafts(wtId, comments);
  }, [wtId, comments]);

  const reload = useCallback(async () => {
    if (!wt) return;
    setLoading(true);
    try {
      const next = await loadDiff(wt, scope);
      setDiff(next);
      setError(null);
      // The lines may have moved since the comments were written.
      setComments((cs) => {
        const placed = anchorComments(cs, next.files);
        setUnplaced(placed.unplaced);
        return placed.comments;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // The worktree row is replaced on every store write; its id and path are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wt?.id, wt?.path, scope]);
  useEffect(() => void reload(), [reload]);

  const totals = useMemo(
    () => (diff ? diff.files.reduce((t, f) => ({ add: t.add + f.insertions, del: t.del + f.deletions }), { add: 0, del: 0 }) : null),
    [diff],
  );
  const byTarget = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of comments) m.set(targetKey(c), [...(m.get(targetKey(c)) ?? []), c]);
    return m;
  }, [comments]);

  if (!wt) return null;
  const taker = takerFor(state, wt.id);
  const sendLabel =
    taker.kind === "agent"
      ? `Send to ${taker.agent.name}`
      : taker.kind === "busy"
        ? `Queue for ${taker.agent.name}`
        : "Start an agent on it";
  const canSend = (comments.length > 0 || summary.trim().length > 0) && !sending && !composing;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const said = await handToBranch(wt.id, reviewPrompt(comments, summary), "address your review");
      flash(said);
      setComments([]);
      setSummary("");
      setState({ view: "sessions" });
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const addComment = (t: Target, text: string) => {
    setComments((cs) => [...cs, { id: `${Date.now()}`, ...t, text }]);
    setComposing(null);
  };
  const jump = (path: string) =>
    scroller.current?.querySelector(`[data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" });

  return (
    <section className="review" aria-labelledby="review-title">
      <header className="usage-head" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <h1 id="review-title">Review {wt.branch}</h1>
          <p className="usage-sub">
            {diff && totals
              ? `${diff.files.length} ${diff.files.length === 1 ? "file" : "files"} changed, `
              : "Reading the diff… "}
            {totals && (
              <>
                <span className="git-add">+{totals.add}</span> <span className="git-del">−{totals.del}</span>
                {scope === "branch" && base ? ` since it left ${base}` : " not yet committed"}
              </>
            )}
            {". Click a line number to comment on it."}
          </p>
        </div>
        <div className="usage-controls" ref={controls}>
          {base && (
            <div className="segmented segmented-sm" role="radiogroup" aria-label="What to review">
              {(["uncommitted", "branch"] as const).map((s) => (
                <button key={s} role="radio" aria-checked={scope === s} className={scope === s ? "is-on" : ""} onClick={() => setScope(s)}>
                  {s === "uncommitted" ? "Uncommitted" : "Whole branch"}
                </button>
              ))}
            </div>
          )}
          <button className="btn btn-sm" onClick={() => void reload()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn btn-sm" onClick={() => setState({ view: "sessions" })} title="Back to sessions (Esc)">
            Done
          </button>
        </div>
      </header>

      {error ? (
        <p className="usage-empty">Couldn't read the diff: {error}</p>
      ) : !diff ? (
        <p className="usage-empty">Reading the diff…</p>
      ) : diff.files.length === 0 ? (
        <p className="usage-empty">
          {scope === "uncommitted"
            ? base
              ? "Nothing uncommitted. Switch to Whole branch to review what's been committed."
              : "Nothing uncommitted here."
            : `No changes since this branch left ${base}.`}
        </p>
      ) : (
        <div className="review-body">
          <nav className="review-files" aria-label="Changed files">
            {diff.files.map((f) => {
              const n = comments.filter((c) => c.path === f.path).length;
              return (
                <button key={f.path} className="review-file" onClick={() => jump(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <span className={`review-mark mark-${f.status}`} aria-label={f.status}>
                    {STATUS_MARK[f.status]}
                  </span>
                  <span className="review-file-name" dir="rtl">
                    <bdi>{f.path}</bdi>
                  </span>
                  {n > 0 && <span className="review-count" title={`${n} comments`}>{n}</span>}
                  <span className="review-stat">
                    {f.insertions > 0 && <span className="git-add">+{f.insertions}</span>}
                    {f.deletions > 0 && <span className="git-del">−{f.deletions}</span>}
                  </span>
                </button>
              );
            })}
            {diff.truncated && <p className="review-note">The diff was too large to show whole.</p>}
          </nav>
          <div className="review-diff" ref={scroller}>
            {comments.some((c) => unplaced.has(c.id)) && (
              <section className="review-filediff review-unplaced" aria-label="Comments not in this diff">
                <header className="review-filehead">
                  <span className="review-path">Not in this diff any more</span>
                  <span className="git-muted">still sent, with the line they quote</span>
                </header>
                <div className="review-thread">
                  {comments
                    .filter((c) => unplaced.has(c.id))
                    .map((c) => (
                      <div key={c.id} className="review-comment">
                        <p>
                          <span className="review-where">
                            {c.path}
                            {c.line !== null ? `:${c.line}` : ""}
                          </span>
                          {c.text}
                        </p>
                        <button className="link-btn" onClick={() => setComments((cs) => cs.filter((x) => x.id !== c.id))}>
                          Delete
                        </button>
                      </div>
                    ))}
                </div>
              </section>
            )}
            {diff.files.map((f) => (
              <FileDiff
                key={`${scope}:${f.path}`}
                file={f}
                comments={byTarget}
                composing={composing}
                onCompose={setComposing}
                onAdd={addComment}
                onDelete={(id) => setComments((cs) => cs.filter((c) => c.id !== id))}
              />
            ))}
          </div>
        </div>
      )}

      <footer className="review-foot">
        <textarea
          className="review-summary"
          rows={1}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Anything else for the agent? (optional)"
          aria-label="Overall note"
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <span className="review-tally">
          {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </span>
        {git && !("error" in git) && <ShipButton worktree={wt} git={git} />}
        <button
          className="btn btn-primary"
          disabled={!canSend}
          onClick={() => void send()}
          title={
            taker.kind === "busy"
              ? `${taker.agent.name} is mid-turn: the review is sent when it finishes (⌘↵)`
              : `${sendLabel} (⌘↵)`
          }
        >
          {sending ? "Sending…" : sendLabel}
        </button>
      </footer>
    </section>
  );
}

function FileDiff({
  file,
  comments,
  composing,
  onCompose,
  onAdd,
  onDelete,
}: {
  file: DiffFile;
  comments: Map<string, ReviewComment[]>;
  composing: Target | null;
  onCompose: (t: Target | null) => void;
  onAdd: (t: Target, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const lines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lines <= FOLD_LINES);
  const fileTarget: Target = { path: file.path, line: null, side: "new", quote: "" };
  const thread = (t: Target) => {
    const key = targetKey(t);
    const here = comments.get(key) ?? [];
    const isComposing = composing && targetKey(composing) === key;
    if (!here.length && !isComposing) return null;
    return (
      <div className="review-thread">
        {here.map((c) => (
          <div key={c.id} className="review-comment">
            <p>{c.text}</p>
            <button className="link-btn" onClick={() => onDelete(c.id)} aria-label="Delete comment">
              Delete
            </button>
          </div>
        ))}
        {isComposing && <Composer onSave={(text) => onAdd(t, text)} onCancel={() => onCompose(null)} />}
      </div>
    );
  };

  return (
    <section className="review-filediff" data-file={file.path}>
      <header className="review-filehead">
        <span className={`review-mark mark-${file.status}`}>{STATUS_MARK[file.status]}</span>
        <span className="review-path">
          {file.oldPath && <span className="git-muted">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className="review-stat">
          {file.insertions > 0 && <span className="git-add">+{file.insertions}</span>}
          {file.deletions > 0 && <span className="git-del">−{file.deletions}</span>}
        </span>
        <button className="link-btn" onClick={() => onCompose(fileTarget)}>
          Comment on file
        </button>
      </header>
      {thread(fileTarget)}
      {file.binary || file.tooBig ? (
        <p className="review-note">{file.tooBig ? "Too large to show." : "Binary file, not shown."}</p>
      ) : !open ? (
        <p className="review-note">
          {lines.toLocaleString()} lines.{" "}
          <button className="link-btn" onClick={() => setOpen(true)}>
            Show them
          </button>
        </p>
      ) : file.hunks.length === 0 ? (
        <p className="review-note">{file.status === "renamed" ? "Renamed, no content changes." : "Empty file."}</p>
      ) : (
        <div className="review-lines" role="table" aria-label={`Changes in ${file.path}`}>
          {file.hunks.map((h, hi) => (
            <Fragment key={hi}>
              <div className="dl dl-hunk" role="row">
                <span role="cell" className="dl-hunk-text">
                  {h.header.replace(/^@@[^@]*@@\s?/, "") || " "}
                </span>
              </div>
              {h.lines.map((l, li) => {
                const t = lineTarget(file.path, l);
                return (
                  <Fragment key={li}>
                    <Line line={l} onComment={() => onCompose(t)} hasComments={comments.has(targetKey(t))} />
                    {thread(t)}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

function lineTarget(path: string, l: DiffLine): Target {
  return l.new !== null ? { path, line: l.new, side: "new", quote: l.text } : { path, line: l.old, side: "old", quote: l.text };
}

function Line({ line, onComment, hasComments }: { line: DiffLine; onComment: () => void; hasComments: boolean }) {
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const n = line.new ?? line.old;
  return (
    <div className={`dl dl-${line.kind}${hasComments ? " has-comments" : ""}`} role="row">
      <span role="cell" className="dl-no">
        {line.old ?? ""}
      </span>
      <span role="cell" className="dl-no">
        {line.new ?? ""}
      </span>
      {/* Not a tab stop: a big diff would be thousands of them. "Comment on
          file" is the keyboard's way in. */}
      <button className="dl-cbtn" tabIndex={-1} onClick={onComment} aria-label={`Comment on line ${n}`} title="Comment on this line">
        +
      </button>
      <span role="cell" className="dl-sign" aria-hidden>
        {sign}
      </span>
      <span role="cell" className="dl-text">
        {line.text || " "}
      </span>
    </div>
  );
}

function Composer({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  const save = () => text.trim() && onSave(text.trim());
  return (
    <div className="review-composer">
      <textarea
        ref={box}
        className="task-box"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should change here?"
        aria-label="Comment"
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="review-composer-foot">
        <span className="hint">
          <kbd>⌘</kbd>
          <kbd>↵</kbd> to add
        </span>
        <button className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={!text.trim()}>
          Add comment
        </button>
      </div>
    </div>
  );
}
