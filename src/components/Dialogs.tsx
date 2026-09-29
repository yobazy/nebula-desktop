import { useEffect, useRef, useState } from "react";

export type TextDialogSpec = {
  kind: "text";
  title: string;
  label: string;
  initial: string;
  multiline?: boolean;
  submit: string;
  /** A line under the field, e.g. what happens to the text. */
  note?: string;
  onSubmit: (v: string) => Promise<void>;
};

/** onConfirm resolving `false` keeps the dialog: it has put up another. */
export type ConfirmDialogSpec = {
  kind: "confirm";
  title: string;
  message: string;
  confirm: string;
  /** Not destructive: the confirm button is the primary one. */
  safe?: boolean;
  onConfirm: () => Promise<boolean | void>;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useEscape(onClose: () => void, busy: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
}

export function TextDialog({ d, onClose }: { d: TextDialogSpec; onClose: () => void }) {
  const [text, setText] = useState(d.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEscape(onClose, busy);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await d.onSubmit(text.trim());
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog dialog-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="row-dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="row-dialog-title">{d.title}</h2>
        {d.multiline ? (
          <textarea
            ref={field}
            className="task-box"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                void submit();
              }
            }}
            aria-label={d.label}
          />
        ) : (
          <input ref={field} className="setting-input run-input" value={text} onChange={(e) => setText(e.target.value)} aria-label={d.label} spellCheck={false} />
        )}
        {d.note && <p className="dialog-note">{d.note}</p>}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
          <span className="hint">
            {d.multiline && (
              <>
                <kbd>⌘</kbd>
                <kbd>↵</kbd> to send
              </>
            )}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
            {d.submit}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function ConfirmDialog({ d, onClose }: { d: ConfirmDialogSpec; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEscape(onClose, busy);
  // Focus lands on Cancel: Enter on a destructive dialog shouldn't delete.
  useEffect(() => cancel.current?.focus(), []);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog dialog-narrow" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h2 id="confirm-title">{d.title}</h2>
        <p id="confirm-body" className="dialog-body">
          {d.message}
        </p>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
          <span className="hint" />
          <button ref={cancel} type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${d.safe ? "btn-primary" : "btn-danger"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if ((await d.onConfirm()) !== false) onClose();
              } catch (e) {
                setError(errText(e));
                setBusy(false);
              }
            }}
          >
            {d.confirm}
          </button>
        </footer>
      </div>
    </div>
  );
}
