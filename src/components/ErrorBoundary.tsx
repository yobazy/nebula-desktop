import { Component, type ReactNode } from "react";

/** Without this, an error thrown while rendering unmounts the whole app and
 *  leaves a blank window. Agents keep running in the daemon either way, so
 *  reloading the view is always safe. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[nebula] render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="scrim" role="alert">
        <div className="dialog dialog-narrow">
          <h2>Something went wrong</h2>
          <p className="dialog-error">{error.message}</p>
          <p className="dialog-body">Your agents are still running in the daemon. Reloading the view is safe.</p>
          <footer className="dialog-foot">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </footer>
        </div>
      </div>
    );
  }
}
