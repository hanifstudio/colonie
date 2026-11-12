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

const screenPath = (botId: string, action: "take" | "hand-back") => `/api/computer/screens/${encodeURIComponent(botId)}/${action}`;

export const computerActions = {
  refresh: () => refresh().finally(schedule),
  turnOn: () => act("/api/computer/on"),
  turnOff: () => act("/api/computer/off"),
  /** The person drives this bot's screen: the bot is paused until they hand it back. */
  takeOver: (botId: string) => act(screenPath(botId, "take")),
  handBack: (botId: string) => act(screenPath(botId, "hand-back")),
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

/** The Screen tab has something to show: a server that can run a computer. Until the first answer, assume so. */
export const screenAvailable = (view: ComputerView | null): boolean => !view || view.state !== "unsupported";

/** Where a bot's panel should open for what is happening now: the screen when the computer is on, the browser otherwise. */
export const placeToWatch = (): "screen" | "browser" => current?.state === "on" ? "screen" : "browser";

/** Where a bot's panel opens when a person asks for its screen: the Screen wherever it can exist. */
export const placeToAsk = (): "screen" | "browser" => screenAvailable(current) ? "screen" : "browser";
