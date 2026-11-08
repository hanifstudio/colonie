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
});

/** Quitting: the computer's memory goes back to the Mac without the quit waiting on the container. */
export async function shutdownComputer(): Promise<void> {
  computerHost.dispose();
  try {
    const facts = await backend.facts();
    if (facts.container === "running" && facts.runtime) stopContainerDetached(facts.runtime as Runtime, CONTAINER);
  } catch { /* quitting anyway */ }
}
