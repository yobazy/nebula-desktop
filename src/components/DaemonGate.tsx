import { useState } from "react";
import { reconnectNow, startDaemon } from "../nebula/client";
import { useAppState } from "../nebula/store";

/** Covers the app until the first Snapshot arrives, and explains a missing
 *  or mismatched daemon in terms of the fix. */
export function DaemonGate() {
  const { link, loaded } = useAppState();
  const [starting, setStarting] = useState(false);
  if (loaded || link.state !== "disconnected") return null;

  const mismatch = link.reason.includes("protocol");
  return (
    <div className="gate" data-tauri-drag-region>
      <div className="gate-card">
        <h1>{mismatch ? "This app and your nebula don’t match" : "nebula isn’t running"}</h1>
        <p>{link.reason}</p>
        {!mismatch && (
          <p>
            Start it here, or run <code>nebula</code> in a terminal. This window connects on its
            own once the daemon is up.
          </p>
        )}
        <div className="gate-actions">
          {!mismatch && (
            <button
              className="btn btn-primary"
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                try {
                  await startDaemon();
                  setTimeout(reconnectNow, 800);
                } finally {
                  setTimeout(() => setStarting(false), 3000);
                }
              }}
            >
              {starting ? "Starting…" : "Start the daemon"}
            </button>
          )}
          <button className="btn" onClick={reconnectNow}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
