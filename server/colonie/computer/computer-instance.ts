// The one bot computer of this server. A module of its own, so the routes, the
// turn that mounts it, and the shutdown all reach the same host.
import { hostedWorkspaceConfigured } from "../../enterprise.ts";
import { createComputerHost } from "./computer-host.ts";
import { containerBackend } from "./container-backend.ts";
import { CONTAINER, stopContainerDetached, type Runtime } from "./container-computer.ts";

const backend = containerBackend();

export const computerHost = createComputerHost({
  backend,
  // A Shared workspace's server runs no bot computer yet.
  supported: () => !hostedWorkspaceConfigured(),
  // the same port the server listens on (server/index.ts)
  gateUrl: () => `http://127.0.0.1:${Number(process.env.COLONIE_PORT || 8799)}/api/internal/computer-gate`,
});

/** Quitting: the computer's memory goes back to the Mac without the quit waiting on the container. */
export async function shutdownComputer(): Promise<void> {
  computerHost.dispose();
  try {
    const facts = await backend.facts();
    if (facts.container === "running" && facts.runtime) stopContainerDetached(facts.runtime as Runtime, CONTAINER);
  } catch { /* quitting anyway */ }
}

/** A turn started working on a bot's screen: the app opens that panel where the person is watching. */
export interface ComputerUse { botId: string; threadId: string; turn: string }
const useListeners = new Set<(use: ComputerUse) => void>();
export const onComputerUse = (listener: (use: ComputerUse) => void): void => { useListeners.add(listener); };
export const announceComputerUse = (use: ComputerUse): void => { for (const listener of useListeners) listener(use); };
