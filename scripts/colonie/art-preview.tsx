import { createRoot } from "react-dom/client";
import { MausAvatar } from "../../src/components/Avatar";
import "../../src/styles.css";

const states = ["idle", "thinking", "working", "alerting", "happy", "sad"] as const;
createRoot(document.getElementById("root")!).render(
  <main className="space-y-8 bg-panel p-8 text-ink">
    <h1 className="text-2xl">Colonie · Bloub artwork</h1>
    {states.map((state) => <section key={state} className="flex items-center gap-6 rounded-xl bg-card p-4">
      <span className="w-24">{state}</span>
      {[24, 44, 80, 140].map((size) => <MausAvatar key={size} label={`${state} ${size}`} color="purple" size={size} state={state} animated={false} />)}
      <MausAvatar label={`${state} animated`} color="blue" size={80} state={state} animated />
    </section>)}
  </main>,
);
