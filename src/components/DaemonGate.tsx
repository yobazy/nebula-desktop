import { useEffect, useState } from "react";
import { installNebula, nebulaStatus, reconnectNow, startDaemon, type NebulaStatus } from "../nebula/client";
import { useAppState } from "../nebula/store";
import { openLink } from "./Run";

const RELEASES = "https://github.com/yobazy/nebula-desktop/releases";

/** -1, 0 or 1 as version `a` is older than, equal to or newer than `b`. */
function compare(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Covers the app until the first Snapshot arrives, and turns what's wrong —
 *  no nebula, the wrong nebula, or nebula not running — into the fix, done
 *  here: the app installs the nebula it's built for itself. */
export function DaemonGate() {
  const { link, loaded } = useAppState();
  const [status, setStatus] = useState<NebulaStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const down = !loaded && link.state === "disconnected";

  useEffect(() => {
    if (down) void nebulaStatus().then(setStatus).catch((e) => setError(String(e)));
  }, [down]);

  if (!down) return null;

  const start = async () => {
    setBusy("start");
    setError(null);
    try {
      await startDaemon();
      setTimeout(reconnectNow, 800);
    } catch (e) {
      setError(String(e));
    } finally {
      setTimeout(() => setBusy(null), 3000);
    }
  };

  const install = async () => {
    setBusy("install");
    setError(null);
    try {
      setStatus(await installNebula());
      // Installed: carry straight on to starting it, so it's one click.
      await startDaemon();
      setTimeout(reconnectNow, 800);
    } catch (e) {
      setError(`Couldn't install nebula: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  const mismatch = link.reason.includes("protocol");
  const pinned = status?.pinned ?? "";
  const order = status?.version ? compare(status.version, pinned) : 0;

  let title = "nebula isn’t running";
  let body: React.ReactNode = (
    <p>
      Start it here, or run <code>nebula</code> in a terminal. This window connects on its own once
      it’s up.
    </p>
  );
  let action: React.ReactNode = (
    <button className="btn btn-primary" disabled={!!busy} onClick={() => void start()}>
      {busy === "start" ? "Starting…" : "Start nebula"}
    </button>
  );

  if (status && !status.path) {
    title = "Set up nebula";
    body = (
      <p>
        Nebula Desktop runs your coding agents through nebula, which isn’t installed yet. This
        installs nebula {pinned} into <code>~/.local/bin</code>, the same place nebula’s own installer
        uses, and starts it.
      </p>
    );
    action = (
      <button className="btn btn-primary" disabled={!!busy} onClick={() => void install()}>
        {busy === "install" ? "Installing…" : `Install nebula ${pinned}`}
      </button>
    );
  } else if (status?.version && order < 0) {
    title = `nebula ${status.version} is older than this app`;
    body = (
      <p>
        This app is built for nebula {pinned}. Updating replaces <code>{status.path}</code>.
        {mismatch && " The daemon that's running stays on the old version until it restarts: quit it with nebula kill in a terminal once your agents are idle, since that stops every session."}
      </p>
    );
    action = (
      <button className="btn btn-primary" disabled={!!busy} onClick={() => void install()}>
        {busy === "install" ? "Updating…" : `Update nebula to ${pinned}`}
      </button>
    );
  } else if (status?.version && order > 0) {
    title = "Nebula Desktop needs an update";
    body = (
      <p>
        Your nebula is {status.version}, and this app is built for {pinned}. nebula only talks to apps
        built for its own version, so get a newer Nebula Desktop.
      </p>
    );
    action = (
      <button className="btn btn-primary" onClick={() => void openLink(RELEASES)}>
        Get the latest app
      </button>
    );
  } else if (mismatch) {
    title = "This app and your nebula don’t match";
    body = <p>{link.reason}</p>;
    action = null;
  }

  return (
    <div className="gate" data-tauri-drag-region>
      <div className="gate-card">
        <h1>{title}</h1>
        {body}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="gate-actions">
          {action}
          <button className="btn" onClick={reconnectNow}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
