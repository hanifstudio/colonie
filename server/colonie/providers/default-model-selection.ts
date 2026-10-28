import type { EffortLevel, EngineAccess, ModelCatalog, ModelSelection, ProviderSnapshot } from "../../contracts.ts";

export interface SelectableInstance {
  instanceId: string;
  driverKind: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
  capabilities?: { effortLevels?: readonly EffortLevel[]; modelVariants?: boolean };
  access?: EngineAccess;
}

const claudeFirst = (instances: readonly SelectableInstance[]) =>
  instances.find((instance) => instance.driverKind === "claude-acp" || instance.driverKind === "claudeAgent") ?? instances[0];

/** Installed and waiting on a sign-in. A custom endpoint brings its own
 * credential, so its sign-in state does not count. */
export function signedOut(instance: SelectableInstance): boolean {
  return instance.snapshot.state === "available" && instance.access !== "custom" && instance.snapshot.authenticated === false;
}

/** The ready rule: an engine can run a turn now when it is available and not
 * signed out (signedOut). */
export function readyToRun(instance: SelectableInstance): boolean {
  return instance.snapshot.state === "available" && !signedOut(instance);
}

/** The engine a new bot gets, and the one a bot moved off a removed engine
 * gets (computer-engine-removal.ts): one picker for both.
 *
 * A saved choice wins while it can run. When it cannot (signed out,
 * unavailable, or its model removed), new bots take an engine that can run a
 * turn now: the app offers no place to change the saved choice, so holding to
 * it left a person with a signed-in engine unable to create any bot. With
 * none that can run, the saved choice still sends new bots to setup.
 * Without a saved choice, an engine that can run a turn now wins (Claude
 * first), then the first available one. */
export function selectDefaultModelSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
): ModelSelection {
  const instance = preferred && instances.find((candidate) => candidate.instanceId === preferred.instanceId);
  if (
    preferred && instance && instance.snapshot.state === "available" && instance.snapshot.authenticated !== false &&
    (preferred.variant === undefined || instance.capabilities?.modelVariants) &&
    (instance.models.default === preferred.model || instance.models.options.some((model) => model.id === preferred.model))
  ) {
    const selection = { ...preferred };
    // A saved effort can outlive driver support. Keep the intentional model,
    // but let the provider use its own effort default instead of failing turn 1.
    if (selection.effort && !instance.capabilities?.effortLevels?.includes(selection.effort)) delete selection.effort;
    return selection;
  }
  const available = instances.filter((instance) => instance.snapshot.state === "available");
  const ready = available.filter((instance) => readyToRun(instance));
  const pick = claudeFirst(ready) ?? (preferred ? undefined : claudeFirst(available));
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}

/** Complete a new bot's selection with the workspace's new-bot effort. An
 * explicit effort or model variant is the caller's choice and wins; an engine
 * that does not offer the level keeps sending none rather than failing turn 1. */
export function withNewBotEffort(
  selection: ModelSelection,
  effort: EffortLevel | undefined,
  offered: readonly EffortLevel[] | undefined,
): ModelSelection {
  if (!effort || selection.effort !== undefined || selection.variant !== undefined || !offered?.includes(effort)) {
    return selection;
  }
  return { ...selection, effort };
}
