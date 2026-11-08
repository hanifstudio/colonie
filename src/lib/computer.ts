import { useEffect, useSyncExternalStore } from "react";
import type { ComputerView } from "../../shared/computer.ts";
import { api } from "@/state/store";

/** The workspace's bot computer, as the panels show it. One poll serves every panel
 * that is open: quick while it is getting ready, slow otherwise. */
let current: ComputerView | null = null;
let failure = "";
let working = false;
let listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let watchers = 0;
const snapshot = () => ({ view: current, error: failure, working });
let cached = snapshot();
const emit = () => { cached = snapshot(); for (const listener of listeners) listener(); };

async function refresh(): Promise<void> {
  try {
    current = await api<ComputerView>("/api/computer");
    failure = "";
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }
  emit();
}

function schedule(): void {
  clearTimeout(timer);
  if (!watchers) return;
  const getting = current?.state === "preparing" || current?.state === "starting";
  timer = setTimeout(() => { void refresh().finally(schedule); }, getting ? 1_000 : 5_000);
}

async function act(path: string): Promise<void> {
  working = true; failure = ""; emit();
  try { current = await api<ComputerView>(path, { method: "POST" }); }
  catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
  finally { working = false; emit(); schedule(); }
}

export const computerActions = {
  refresh: () => refresh().finally(schedule),
  turnOn: () => act("/api/computer/on"),
  turnOff: () => act("/api/computer/off"),
};

/** Test seam: forget what a previous test saw. */
export function resetComputerStore(): void {
  current = null; failure = ""; working = false; clearTimeout(timer); watchers = 0; listeners = new Set(); cached = snapshot();
}

export function useComputer() {
  const state = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => cached,
  );
  useEffect(() => {
    watchers++;
    void refresh().finally(schedule);
    return () => { watchers--; if (!watchers) clearTimeout(timer); };
  }, []);
  return { ...state, ...computerActions };
}

/** What the panel's first tab is called: the computer, or the browser where there is none. */
export const computerTabLabel = (view: ComputerView | null): "Computer" | "Browser" => view && view.state !== "unsupported" ? "Computer" : "Browser";
