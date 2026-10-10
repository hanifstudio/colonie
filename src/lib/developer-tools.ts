import { useSyncExternalStore } from "react";

/** Inspection is separate from Advanced UI and always opt-in on this device. */
export const DEVELOPER_TOOLS_KEY = "colonie-developer-tools";
const listeners = new Set<() => void>();
let sessionChoice: boolean | undefined;
export function readDeveloperTools(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try { return globalThis.localStorage?.getItem(DEVELOPER_TOOLS_KEY) === "1"; }
  catch { return false; }
}
function notify() { for (const listener of listeners) listener(); }
function onStorage(event: StorageEvent) {
  if (event.key !== DEVELOPER_TOOLS_KEY && event.key !== null) return;
  sessionChoice = undefined; notify();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
export function setDeveloperTools(enabled: boolean) {
  sessionChoice = enabled;
  try { globalThis.localStorage?.setItem(DEVELOPER_TOOLS_KEY, enabled ? "1" : "0"); }
  catch { /* Keep the explicit choice for this session if storage is blocked. */ }
  notify();
}
export function useDeveloperTools() { return useSyncExternalStore(subscribe, readDeveloperTools, () => false); }
