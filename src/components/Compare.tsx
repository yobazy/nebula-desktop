import { useRef, useState } from "react";
import { useOverlayKeys } from "./Overlay";
import { flash, getState, setState, useAppState, worktreeAgents } from "../nebula/store";
import { changedFiles } from "../nebula/git";
import { agentSpec, relativeTime, STATUS_LABEL } from "../nebula/status";
import { forget, keepAttempt } from "../nebula/fanout";
import { openReview } from "../nebula/diff";
import { selectAgent } from "./Sidebar";
import { ConfirmDialog, type ConfirmDialogSpec } from "./Dialogs";

/** A fanned-out task's attempts side by side: who's done, how much each
 *  changed, and one click to keep the best and drop the rest. */
export function CompareView() {
  const state = useAppState();
  const group = state.compare ? state.fanouts[state.compare] : undefined;
  const [dialog, setDialog] = useState<ConfirmDialogSpec | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  useOverlayKeys(controls);
  if (!group) {
    // Kept, ungrouped or deleted elsewhere: say so rather than leave the
    // columns underneath covered by nothing.
    return (
      <section className="review compare" aria-labelledby="compare-title">
        <header className="usage-head" data-tauri-drag-region>
          <h1 id="compare-title">Compare attempts</h1>
          <div className="usage-controls" ref={controls}>
            <button className="btn btn-sm" onClick={() => setState({ view: "sessions" })}>
              Done
            </button>
          </div>
        </header>
        <p className="usage-empty">This comparison is closed.</p>
      </section>
    );
  }
  const attempts = group.worktrees.map((id) => state.worktrees[id]).filter((w) => !!w);
  // Done: it has a task and every task has ended its turn (or stopped).
  const done = attempts.filter((w) => {
    const agents = worktreeAgents(state, w.id);
    return agents.length > 0 && agents.every((a) => a.status === "finished" || a.status === "terminated");
  }).length;

  const keep = (id: string, branch: string) =>
    setDialog({
      kind: "confirm",
      title: `Keep ${branch}?`,
      message: `The other ${attempts.length - 1} ${attempts.length === 2 ? "attempt is" : "attempts are"} deleted: their worktrees, sessions, uncommitted work and local branches. ${branch} stays as an ordinary worktree.`,
      confirm: `Keep ${branch}`,
      onConfirm: async () => {
        try {
          await keepAttempt(group.id, id);
        } catch (e) {
          // With the group gone this dialog is too: say it in the notice.
          if (getState().fanouts[group.id]) throw e;
          flash(e instanceof Error ? e.message : String(e));
          setState({ view: "sessions" });
          return;
        }
        flash(`Kept ${branch}`);
        setState({ view: "sessions" });
      },
    });

  return (
    <section className="review compare" aria-labelledby="compare-title">
      <header className="usage-head" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <h1 id="compare-title">Compare attempts</h1>
          <p className="usage-sub compare-prompt" title={group.prompt}>
            {group.prompt}
          </p>
        </div>
        <div className="usage-controls" ref={controls}>
          <span className="usage-note">
            {done} of {attempts.length} done
          </span>
          <button
            className="btn btn-sm"
            onClick={() => {
              forget(group.id);
              setState({ view: "sessions" });
            }}
            title="Stop grouping these; the worktrees stay as they are"
          >
            Ungroup
          </button>
          <button className="btn btn-sm" onClick={() => setState({ view: "sessions" })} title="Back to sessions (Esc)">
            Done
          </button>
        </div>
      </header>
      {attempts.length === 0 ? (
        <p className="usage-empty">These attempts have all been deleted.</p>
      ) : (
        <div className="compare-grid">
          {attempts.map((wt) => {
            const agents = worktreeAgents(state, wt.id);
            const agent = agents[0];
            const git = state.git[wt.id];
            const g = git && !("error" in git) ? git : null;
            const pr = state.prs[wt.id];
            return (
              <article key={wt.id} className="attempt">
                <header className="attempt-head">
                  <h2 title={wt.branch}>{wt.branch}</h2>
                  {agent && <span className="attempt-spec">{agentSpec(agent)}</span>}
                </header>
                {agent ? (
                  <button className="attempt-status" onClick={() => selectAgent(agent)} title="Open this attempt's terminal">
                    <span className={`sdot dot-${agent.status}${agent.unseen ? " is-unseen" : ""}`} aria-hidden />
                    <span>{STATUS_LABEL[agent.status]}</span>
                    <span className="git-muted">{relativeTime(agent.status_changed_at)}</span>
                  </button>
                ) : (
                  <p className="attempt-status git-muted">No task running</p>
                )}
                <dl className="attempt-stats">
                  <div>
                    <dt>Files</dt>
                    <dd>{g ? changedFiles(g) : "…"}</dd>
                  </div>
                  <div>
                    <dt>Lines</dt>
                    <dd>
                      {g ? (
                        <>
                          <span className="git-add">+{g.insertions}</span> <span className="git-del">−{g.deletions}</span>
                        </>
                      ) : (
                        "…"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Commits</dt>
                    <dd>{g?.baseAhead ?? 0}</dd>
                  </div>
                  {pr?.kind === "found" && (
                    <div>
                      <dt>PR</dt>
                      <dd>#{pr.pr.number}</dd>
                    </div>
                  )}
                </dl>
                {g?.lastCommit && <p className="attempt-last">{g.lastCommit.subject}</p>}
                <footer className="attempt-foot">
                  <button className="btn btn-sm" onClick={() => openReview(wt.id)}>
                    Review diff
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => keep(wt.id, wt.branch)} disabled={attempts.length < 2}>
                    Keep this one
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {dialog && <ConfirmDialog d={dialog} onClose={() => setDialog(null)} />}
    </section>
  );
}
