import { useEffect, useState } from "react";
import { answer, findQuestion, lastRows, looksLikePicker, readScreen, type Choice, type Question } from "../nebula/screen";
import { deliverPrompt } from "../nebula/actions";
import { flash } from "../nebula/store";
import type { Agent } from "../nebula/types";

const POLL_MS = 1_500;

/** Answer a waiting agent without opening its terminal: its numbered
 *  choices as buttons when it's showing some (a permission prompt), else
 *  the end of its screen and a line to reply on. */
export function QuickAnswer({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  // undefined while the first read is out; null when there's no live
  // terminal to read.
  const [screen, setScreen] = useState<string[] | null | undefined>(undefined);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    // Each read waits for the last: a slow daemon mustn't pile them up.
    const read = async () => {
      const lines = document.hidden ? undefined : await readScreen(agent).catch(() => null);
      if (!live) return;
      if (lines !== undefined) setScreen(lines);
      t = setTimeout(read, POLL_MS);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(t);
    };
    // Re-reading on every agent update would restart the poll each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, agent.alive]);

  const pick = async (q: Question, c: Choice) => {
    setBusy(true);
    try {
      await answer(agent, q, c);
      flash(`Answered ${agent.name}: ${c.label}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setTimeout(() => setBusy(false), 800);
    }
  };

  const send = async () => {
    if (!reply.trim() || busy) return;
    setBusy(true);
    try {
      await deliverPrompt(agent, reply.trim());
      setReply("");
      flash(`Replied to ${agent.name}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (screen === undefined) return <div className="qa qa-muted">Reading its screen…</div>;
  if (screen === null)
    return (
      <div className="qa qa-muted">
        Its terminal isn't running.{" "}
        <button className="link-btn" onClick={onOpen}>
          Open it
        </button>
      </div>
    );

  const q = findQuestion(screen);
  if (q) {
    return (
      <div className="qa" role="group" aria-label={`Answer ${agent.name}`}>
        {q.prompt && <p className="qa-prompt">{q.prompt}</p>}
        <div className="qa-choices">
          {q.choices.map((c) => (
            <button
              key={c.key}
              className={`qa-choice${c.selected ? " is-current" : ""}`}
              disabled={busy}
              onClick={() => void pick(q, c)}
              title={c.label}
            >
              <kbd>{c.key}</kbd>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // A picker that couldn't be read: a typed reply's Enter would pick
  // whatever row is current, so send you to the terminal instead.
  if (looksLikePicker(screen))
    return (
      <div className="qa" role="group" aria-label={agent.name}>
        <pre className="qa-tail">{lastRows(screen, 5).join("\n")}</pre>
        <p className="qa-muted">
          It's showing a menu this can't read.{" "}
          <button className="link-btn" onClick={onOpen}>
            Open it to answer
          </button>
        </p>
      </div>
    );

  return (
    <div className="qa" role="group" aria-label={`Reply to ${agent.name}`}>
      <pre className="qa-tail">{lastRows(screen, 5).join("\n")}</pre>
      <form
        className="qa-reply"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Reply…"
          aria-label={`Reply to ${agent.name}`}
          spellCheck={false}
          disabled={busy}
        />
        <button className="btn btn-sm" type="submit" disabled={busy || !reply.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
