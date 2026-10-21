// The app never fails to a black screen with no way out. A screen that
// throws shows what happened, Reload, and, in the desktop app on a Shared
// workspace, Back to this computer: a broken server must not lock the person
// out of their own computer. Plain markup and inline style only, so this
// still draws when the app's own pieces are what failed.
import { Component, useEffect, useState, type ReactNode } from "react";

function Fallback({ error }: { error: Error }) {
  const bridge = typeof window !== "undefined" ? window.colonie?.workspaces : undefined;
  const [remote, setRemote] = useState(false);
  useEffect(() => {
    void bridge?.state().then((state) => setRemote(!state.local)).catch(() => {});
  }, [bridge]);
  const button = { padding: "10px 16px", borderRadius: 12, border: 0, font: "inherit", fontWeight: 600, cursor: "pointer" } as const;
  return (
    <main role="alert" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#080808", color: "#fcfcfc", font: "15px/1.5 system-ui, sans-serif" }}>
      <div style={{ maxWidth: 440, width: "100%", background: "#111111", border: "1px solid #333", borderRadius: 20, padding: 28 }}>
        <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Something went wrong</h1>
        <p style={{ color: "#fcfcfc99", margin: "0 0 4px" }}>This screen could not be shown. Your conversations and settings are safe.</p>
        <p style={{ color: "#fcfcfc66", fontSize: 12.5, margin: "0 0 18px", wordBreak: "break-word" }}>{error.message}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={{ ...button, background: "#7b61ff", color: "#fff" }} onClick={() => location.reload()}>Reload</button>
          {remote && bridge?.thisComputer && (
            <button type="button" style={{ ...button, background: "#2f2f2f", color: "#fcfcfc" }} onClick={() => void bridge.thisComputer?.()}>Back to this computer</button>
          )}
        </div>
      </div>
    </main>
  );
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: unknown) {
    console.error("The app failed to draw:", error);
  }
  render() {
    return this.state.error ? <Fallback error={this.state.error} /> : this.props.children;
  }
}
