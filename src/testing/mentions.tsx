import { createRoot } from "react-dom/client";
import { StoreProvider, useStore } from "../state/store.tsx";
import { ChatView } from "../components/ChatView";
import { DesktopCapabilitiesProvider } from "../components/DesktopCapabilities";
import { applySkin } from "../lib/skins";
import "../styles.css";

function Fixture() {
  const { state } = useStore();
  const bot = state.bots.find((b) => b.name === "Atlas");
  return <div className="flex h-dvh flex-col bg-app text-ink">
    <nav className="flex shrink-0 flex-wrap gap-4 border-b border-hairline px-6 py-3 text-sm">
      <span className="font-semibold">Colonie · Isolated mention verification</span>
      <button onClick={() => applySkin("midnight")}>Dark</button>
      <button onClick={() => applySkin("atelier")}>Light</button>
    </nav>
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {bot ? <ChatView bot={bot} /> : <p>Loading fixture…</p>}
    </main>
  </div>;
}
applySkin("midnight");
createRoot(document.getElementById("root")!).render(
  <StoreProvider><DesktopCapabilitiesProvider><Fixture /></DesktopCapabilitiesProvider></StoreProvider>,
);
